import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("GHOSTGRAM_DATA_DIR", str(BASE_DIR / "data")))
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "ghostgram.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


@contextmanager
def db_session():
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db_session() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                avatar_color TEXT NOT NULL DEFAULT '#2AABEE',
                bio TEXT NOT NULL DEFAULT '',
                ghost_enabled INTEGER NOT NULL DEFAULT 0,
                hide_read_receipts INTEGER NOT NULL DEFAULT 1,
                hide_online INTEGER NOT NULL DEFAULT 1,
                hide_typing INTEGER NOT NULL DEFAULT 0,
                live_typing_share INTEGER NOT NULL DEFAULT 1,
                last_seen INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                is_group INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL DEFAULT '',
                avatar_color TEXT NOT NULL DEFAULT '#3B82F6',
                created_by INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (created_by) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS chat_members (
                chat_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                joined_at INTEGER NOT NULL,
                PRIMARY KEY (chat_id, user_id),
                FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                file_id TEXT,
                file_name TEXT,
                file_mime TEXT,
                file_size INTEGER,
                reply_to_id INTEGER,
                edited_at INTEGER,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at INTEGER,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS message_reads (
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                read_at INTEGER NOT NULL,
                PRIMARY KEY (message_id, user_id),
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
            """
        )


def serialize_user(row: sqlite3.Row, include_ghost: bool = False) -> Dict[str, Any]:
    data = {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "avatar_color": row["avatar_color"],
        "bio": row["bio"],
        "last_seen": row["last_seen"],
    }
    if include_ghost:
        data["ghost"] = {
            "enabled": bool(row["ghost_enabled"]),
            "hide_read_receipts": bool(row["hide_read_receipts"]),
            "hide_online": bool(row["hide_online"]),
            "hide_typing": bool(row["hide_typing"]),
            "live_typing_share": bool(row["live_typing_share"]),
        }
    return data


def get_user_by_id(user_id: int) -> Optional[sqlite3.Row]:
    with db_session() as conn:
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def get_user_by_username(username: str) -> Optional[sqlite3.Row]:
    with db_session() as conn:
        return conn.execute("SELECT * FROM users WHERE lower(username) = lower(?)", (username.strip(),)).fetchone()


def create_user(username: str, display_name: str, password_hash: str, avatar_color: str) -> sqlite3.Row:
    now = int(time.time())
    with db_session() as conn:
        cur = conn.execute(
            """
            INSERT INTO users (username, display_name, password_hash, avatar_color, last_seen, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (username.strip().lower(), display_name.strip(), password_hash, avatar_color, now, now),
        )
        return conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()


def update_ghost_settings(
    user_id: int,
    enabled: bool,
    hide_read_receipts: bool,
    hide_online: bool,
    hide_typing: bool,
    live_typing_share: bool,
) -> sqlite3.Row:
    with db_session() as conn:
        conn.execute(
            """
            UPDATE users
            SET ghost_enabled = ?,
                hide_read_receipts = ?,
                hide_online = ?,
                hide_typing = ?,
                live_typing_share = ?
            WHERE id = ?
            """,
            (
                int(enabled),
                int(hide_read_receipts),
                int(hide_online),
                int(hide_typing),
                int(live_typing_share),
                user_id,
            ),
        )
        return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def touch_last_seen(user_id: int) -> None:
    with db_session() as conn:
        conn.execute("UPDATE users SET last_seen = ? WHERE id = ?", (int(time.time()), user_id))


def search_users(query: str, exclude_user_id: int) -> List[Dict[str, Any]]:
    q = f"%{query.strip().lower()}%"
    with db_session() as conn:
        rows = conn.execute(
            """
            SELECT * FROM users
            WHERE id != ? AND (lower(username) LIKE ? OR lower(display_name) LIKE ?)
            ORDER BY username ASC
            LIMIT 25
            """,
            (exclude_user_id, q, q),
        ).fetchall()
        return [serialize_user(r) for r in rows]


def get_or_create_direct_chat(user_a: int, user_b: int) -> int:
    with db_session() as conn:
        existing = conn.execute(
            """
            SELECT c.id FROM chats c
            JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
            JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
            WHERE c.is_group = 0
            LIMIT 1
            """,
            (user_a, user_b),
        ).fetchone()
        if existing:
            return existing["id"]

        now = int(time.time())
        cur = conn.execute(
            "INSERT INTO chats (is_group, title, created_by, created_at) VALUES (0, '', ?, ?)",
            (user_a, now),
        )
        chat_id = cur.lastrowid
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
            (chat_id, user_a, now),
        )
        if user_b != user_a:
            conn.execute(
                "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
                (chat_id, user_b, now),
            )
        return chat_id


def create_group_chat(creator_id: int, title: str, member_ids: List[int], avatar_color: str) -> int:
    now = int(time.time())
    unique_members = list(dict.fromkeys([creator_id] + [int(m) for m in member_ids]))
    with db_session() as conn:
        cur = conn.execute(
            "INSERT INTO chats (is_group, title, avatar_color, created_by, created_at) VALUES (1, ?, ?, ?, ?)",
            (title.strip(), avatar_color, creator_id, now),
        )
        chat_id = cur.lastrowid
        for uid in unique_members:
            role = "admin" if uid == creator_id else "member"
            conn.execute(
                "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
                (chat_id, uid, role, now),
            )
        return chat_id


def is_chat_member(chat_id: int, user_id: int) -> bool:
    with db_session() as conn:
        row = conn.execute(
            "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?",
            (chat_id, user_id),
        ).fetchone()
        return row is not None


def get_chat_member_ids(chat_id: int) -> List[int]:
    with db_session() as conn:
        rows = conn.execute("SELECT user_id FROM chat_members WHERE chat_id = ?", (chat_id,)).fetchall()
        return [r["user_id"] for r in rows]


def get_user_chats(user_id: int, online_user_ids: set) -> List[Dict[str, Any]]:
    with db_session() as conn:
        chat_rows = conn.execute(
            """
            SELECT c.* FROM chats c
            JOIN chat_members cm ON cm.chat_id = c.id
            WHERE cm.user_id = ?
            ORDER BY c.created_at DESC
            """,
            (user_id,),
        ).fetchall()

        results = []
        for c in chat_rows:
            cid = c["id"]
            members = conn.execute(
                """
                SELECT u.* FROM users u
                JOIN chat_members cm ON cm.user_id = u.id
                WHERE cm.chat_id = ?
                """,
                (cid,),
            ).fetchall()

            last_msg = conn.execute(
                """
                SELECT m.*, u.display_name AS sender_name FROM messages m
                JOIN users u ON u.id = m.sender_id
                WHERE m.chat_id = ? AND m.is_deleted = 0
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
                """,
                (cid,),
            ).fetchone()

            unread_row = conn.execute(
                """
                SELECT COUNT(*) AS cnt FROM messages m
                WHERE m.chat_id = ?
                  AND m.sender_id != ?
                  AND m.is_deleted = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM message_reads mr
                      WHERE mr.message_id = m.id AND mr.user_id = ?
                  )
                """,
                (cid, user_id, user_id),
            ).fetchone()

            is_group = bool(c["is_group"])
            peer = None
            if not is_group:
                for m in members:
                    if m["id"] != user_id:
                        peer = m
                        break
                if peer is None and members:
                    peer = members[0]

            if is_group:
                title = c["title"]
                avatar_color = c["avatar_color"]
                peer_online = False
                peer_username = f"{len(members)} a'zo"
                peer_id = None
                peer_last_seen = 0
            else:
                title = peer["display_name"] if peer else "Saqlangan xabarlar"
                avatar_color = peer["avatar_color"] if peer else "#2AABEE"
                peer_id = peer["id"] if peer else user_id
                is_hidden_online = bool(peer["ghost_enabled"] and peer["hide_online"]) if peer else False
                peer_online = (peer_id in online_user_ids) and not is_hidden_online
                peer_username = f"@{peer['username']}" if peer else ""
                peer_last_seen = 0 if is_hidden_online else (peer["last_seen"] if peer else 0)

            results.append(
                {
                    "id": cid,
                    "is_group": is_group,
                    "title": title,
                    "avatar_color": avatar_color,
                    "peer_id": peer_id,
                    "peer_username": peer_username,
                    "peer_online": peer_online,
                    "peer_last_seen": peer_last_seen,
                    "member_count": len(members),
                    "members": [serialize_user(m) for m in members],
                    "unread_count": unread_row["cnt"] if unread_row else 0,
                    "last_message": {
                        "id": last_msg["id"],
                        "content": last_msg["content"],
                        "file_name": last_msg["file_name"],
                        "sender_name": last_msg["sender_name"],
                        "sender_id": last_msg["sender_id"],
                        "created_at": last_msg["created_at"],
                    }
                    if last_msg
                    else None,
                    "sort_ts": last_msg["created_at"] if last_msg else c["created_at"],
                }
            )

        results.sort(key=lambda x: x["sort_ts"], reverse=True)
        return results


def create_message(
    chat_id: int,
    sender_id: int,
    content: str = "",
    file_id: Optional[str] = None,
    file_name: Optional[str] = None,
    file_mime: Optional[str] = None,
    file_size: Optional[int] = None,
    reply_to_id: Optional[int] = None,
) -> Dict[str, Any]:
    now = int(time.time())
    with db_session() as conn:
        cur = conn.execute(
            """
            INSERT INTO messages (
                chat_id, sender_id, content, file_id, file_name, file_mime, file_size, reply_to_id, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (chat_id, sender_id, content, file_id, file_name, file_mime, file_size, reply_to_id, now),
        )
        msg_id = cur.lastrowid
        return get_message_by_id(msg_id, conn)


def get_message_by_id(message_id: int, conn: Optional[sqlite3.Connection] = None) -> Optional[Dict[str, Any]]:
    def _fetch(c: sqlite3.Connection) -> Optional[Dict[str, Any]]:
        row = c.execute(
            """
            SELECT m.*, u.username AS sender_username, u.display_name AS sender_name, u.avatar_color AS sender_color
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.id = ?
            """,
            (message_id,),
        ).fetchone()
        if not row:
            return None
        reads = c.execute(
            "SELECT user_id, read_at FROM message_reads WHERE message_id = ?",
            (message_id,),
        ).fetchall()
        return {
            "id": row["id"],
            "chat_id": row["chat_id"],
            "sender_id": row["sender_id"],
            "sender_username": row["sender_username"],
            "sender_name": row["sender_name"],
            "sender_color": row["sender_color"],
            "content": row["content"],
            "file_id": row["file_id"],
            "file_name": row["file_name"],
            "file_mime": row["file_mime"],
            "file_size": row["file_size"],
            "file_url": f"/api/files/{row['file_id']}" if row["file_id"] and not row["is_deleted"] else None,
            "reply_to_id": row["reply_to_id"],
            "edited_at": row["edited_at"],
            "is_deleted": bool(row["is_deleted"]),
            "deleted_at": row["deleted_at"],
            "created_at": row["created_at"],
            "read_by": [r["user_id"] for r in reads],
        }

    if conn is not None:
        return _fetch(conn)
    with db_session() as c:
        return _fetch(c)


def get_chat_messages(chat_id: int, limit: int = 100) -> List[Dict[str, Any]]:
    with db_session() as conn:
        rows = conn.execute(
            """
            SELECT id FROM messages
            WHERE chat_id = ? AND is_deleted = 0
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (chat_id, limit),
        ).fetchall()
        msgs = [get_message_by_id(r["id"], conn) for r in reversed(rows)]
        return [m for m in msgs if m is not None]


def edit_message(message_id: int, user_id: int, new_content: str) -> Optional[Dict[str, Any]]:
    now = int(time.time())
    with db_session() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id = ? AND sender_id = ? AND is_deleted = 0", (message_id, user_id)).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
            (new_content, now, message_id),
        )
        return get_message_by_id(message_id, conn)


def delete_message(message_id: int, user_id: int) -> Optional[Dict[str, Any]]:
    now = int(time.time())
    with db_session() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row or row["sender_id"] != user_id:
            return None
        file_id = row["file_id"]
        chat_id = row["chat_id"]
        conn.execute(
            "UPDATE messages SET is_deleted = 1, deleted_at = ?, content = '', file_id = NULL WHERE id = ?",
            (now, message_id),
        )
    # Remove file from server disk so only client-side local storage retains it!
    if file_id:
        for p in UPLOAD_DIR.glob(f"{file_id}*"):
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
    return {"message_id": message_id, "chat_id": chat_id, "deleted_at": now, "deleted_by": user_id}


def mark_chat_read(chat_id: int, user_id: int) -> List[int]:
    now = int(time.time())
    with db_session() as conn:
        rows = conn.execute(
            """
            SELECT m.id FROM messages m
            WHERE m.chat_id = ?
              AND m.sender_id != ?
              AND m.is_deleted = 0
              AND NOT EXISTS (
                  SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?
              )
            """,
            (chat_id, user_id, user_id),
        ).fetchall()
        ids = [r["id"] for r in rows]
        for mid in ids:
            conn.execute(
                "INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)",
                (mid, user_id, now),
            )
        return ids
