import json
import mimetypes
import os
import random
import re
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import (
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

try:
    from . import auth, database as db
except ImportError:
    import auth
    import database as db

HERE = Path(__file__).resolve().parent
STATIC_DIR = (HERE.parent / "static") if (HERE.parent / "static").exists() else (
    (HERE / "static") if (HERE / "static").exists() else HERE
)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB

AVATAR_COLORS = [
    "#2AABEE",
    "#8B5CF6",
    "#10B981",
    "#F59E0B",
    "#EF4444",
    "#EC4899",
    "#06B6D4",
    "#6366F1",
]

app = FastAPI(title="GhostGram", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self) -> None:
        self.active: Dict[int, Set[WebSocket]] = {}

    async def connect(self, user_id: int, ws: WebSocket) -> None:
        await ws.accept()
        self.active.setdefault(user_id, set()).add(ws)

    def disconnect(self, user_id: int, ws: WebSocket) -> bool:
        sockets = self.active.get(user_id)
        if not sockets:
            return True
        sockets.discard(ws)
        if not sockets:
            self.active.pop(user_id, None)
            return True
        return False

    def online_user_ids(self) -> Set[int]:
        return set(self.active.keys())

    async def send_to_user(self, user_id: int, payload: dict) -> None:
        sockets = list(self.active.get(user_id, set()))
        dead = []
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(user_id, ws)

    async def broadcast_to_chat(self, chat_id: int, payload: dict, exclude_user_id: Optional[int] = None) -> None:
        members = db.get_chat_member_ids(chat_id)
        for uid in members:
            if exclude_user_id is not None and uid == exclude_user_id:
                continue
            await self.send_to_user(uid, payload)

    async def broadcast_presence(self, user_id: int, is_online: bool) -> None:
        user = db.get_user_by_id(user_id)
        if not user:
            return
        hidden = bool(user["ghost_enabled"] and user["hide_online"])
        effective_online = is_online and not hidden
        effective_last_seen = 0 if hidden else user["last_seen"]
        payload = {
            "type": "presence_update",
            "user_id": user_id,
            "online": effective_online,
            "last_seen": effective_last_seen,
        }
        for uid in list(self.active.keys()):
            if uid != user_id:
                await self.send_to_user(uid, payload)


manager = ConnectionManager()


@app.on_event("startup")
def on_startup() -> None:
    db.init_db()


# ---------- Pydantic Schemas ----------
class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=24)
    display_name: str = Field(..., min_length=1, max_length=40)
    password: str = Field(..., min_length=4, max_length=128)


class LoginRequest(BaseModel):
    username: str
    password: str


class GhostSettingsRequest(BaseModel):
    enabled: bool = False
    hide_read_receipts: bool = True
    hide_online: bool = True
    hide_typing: bool = False
    live_typing_share: bool = True


class DirectChatRequest(BaseModel):
    target_user_id: int


class GroupChatRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=60)
    member_ids: List[int] = Field(default_factory=list)


class SendMessageRequest(BaseModel):
    content: str = ""
    file_id: Optional[str] = None
    file_name: Optional[str] = None
    file_mime: Optional[str] = None
    file_size: Optional[int] = None
    reply_to_id: Optional[int] = None


class EditMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)


# ---------- Auth Dependency ----------
def get_current_user(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Avtorizatsiya talab qilinadi")
    token = authorization.split(" ", 1)[1].strip()
    payload = auth.verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Token yaroqsiz yoki muddati tugagan")
    user = db.get_user_by_id(payload["uid"])
    if not user:
        raise HTTPException(status_code=401, detail="Foydalanuvchi topilmadi")
    return user


# ---------- Auth Endpoints ----------
@app.post("/api/auth/register")
def register(req: RegisterRequest):
    username = req.username.strip().lower()
    if not re.match(r"^[a-z0-9_]{3,24}$", username):
        raise HTTPException(status_code=400, detail="Username faqat kichik harf, raqam va '_' dan iborat bo'lsin")
    if db.get_user_by_username(username):
        raise HTTPException(status_code=409, detail="Bu username allaqachon band")
    color = random.choice(AVATAR_COLORS)
    user = db.create_user(username, req.display_name, auth.hash_password(req.password), color)
    db.get_or_create_direct_chat(user["id"], user["id"])
    token = auth.create_token(user["id"], user["username"])
    return {"token": token, "user": db.serialize_user(user, include_ghost=True)}


@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = db.get_user_by_username(req.username)
    if not user or not auth.verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Username yoki parol noto'g'ri")
    db.touch_last_seen(user["id"])
    token = auth.create_token(user["id"], user["username"])
    return {"token": token, "user": db.serialize_user(user, include_ghost=True)}


@app.get("/api/auth/me")
def me(user=Depends(get_current_user)):
    return {"user": db.serialize_user(user, include_ghost=True)}


@app.put("/api/settings/ghost")
async def update_ghost(req: GhostSettingsRequest, user=Depends(get_current_user)):
    updated = db.update_ghost_settings(
        user["id"],
        enabled=req.enabled,
        hide_read_receipts=req.hide_read_receipts,
        hide_online=req.hide_online,
        hide_typing=req.hide_typing,
        live_typing_share=req.live_typing_share,
    )
    await manager.broadcast_presence(user["id"], user["id"] in manager.online_user_ids())
    return {"user": db.serialize_user(updated, include_ghost=True)}


# ---------- Users & Chats ----------
@app.get("/api/users/search")
def search_users(q: str = Query(default=""), user=Depends(get_current_user)):
    return {"users": db.search_users(q, exclude_user_id=user["id"])}


@app.get("/api/chats")
def list_chats(user=Depends(get_current_user)):
    return {"chats": db.get_user_chats(user["id"], manager.online_user_ids())}


@app.post("/api/chats/direct")
async def open_direct_chat(req: DirectChatRequest, user=Depends(get_current_user)):
    target = db.get_user_by_id(req.target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Foydalanuvchi topilmadi")
    chat_id = db.get_or_create_direct_chat(user["id"], target["id"])
    await manager.broadcast_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    return {"chat_id": chat_id}


@app.post("/api/chats/group")
async def create_group(req: GroupChatRequest, user=Depends(get_current_user)):
    color = random.choice(AVATAR_COLORS)
    chat_id = db.create_group_chat(user["id"], req.title, req.member_ids, color)
    await manager.broadcast_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    return {"chat_id": chat_id}


# ---------- Messages ----------
@app.get("/api/chats/{chat_id}/messages")
def list_messages(chat_id: int, limit: int = 100, user=Depends(get_current_user)):
    if not db.is_chat_member(chat_id, user["id"]):
        raise HTTPException(status_code=403, detail="Bu chatga ruxsatingiz yo'q")
    return {"messages": db.get_chat_messages(chat_id, limit=min(limit, 300))}


@app.post("/api/chats/{chat_id}/messages")
async def send_message(chat_id: int, req: SendMessageRequest, user=Depends(get_current_user)):
    if not db.is_chat_member(chat_id, user["id"]):
        raise HTTPException(status_code=403, detail="Bu chatga ruxsatingiz yo'q")
    if not req.content.strip() and not req.file_id:
        raise HTTPException(status_code=400, detail="Xabar matni yoki fayl bo'lishi kerak")

    msg = db.create_message(
        chat_id=chat_id,
        sender_id=user["id"],
        content=req.content.strip(),
        file_id=req.file_id,
        file_name=req.file_name,
        file_mime=req.file_mime,
        file_size=req.file_size,
        reply_to_id=req.reply_to_id,
    )
    await manager.broadcast_to_chat(
        chat_id,
        {"type": "live_draft", "chat_id": chat_id, "user_id": user["id"], "text": ""},
        exclude_user_id=user["id"],
    )
    await manager.broadcast_to_chat(chat_id, {"type": "new_message", "message": msg})
    return {"message": msg}


@app.put("/api/messages/{message_id}")
async def edit_message(message_id: int, req: EditMessageRequest, user=Depends(get_current_user)):
    updated = db.edit_message(message_id, user["id"], req.content.strip())
    if not updated:
        raise HTTPException(status_code=404, detail="Xabar topilmadi yoki tahrirlashga ruxsat yo'q")
    await manager.broadcast_to_chat(updated["chat_id"], {"type": "message_edited", "message": updated})
    return {"message": updated}


@app.delete("/api/messages/{message_id}")
async def delete_message(message_id: int, user=Depends(get_current_user)):
    result = db.delete_message(message_id, user["id"])
    if not result:
        raise HTTPException(status_code=404, detail="Xabar topilmadi yoki o'chirishga ruxsat yo'q")
    await manager.broadcast_to_chat(
        result["chat_id"],
        {
            "type": "message_deleted",
            "chat_id": result["chat_id"],
            "message_id": result["message_id"],
            "deleted_at": result["deleted_at"],
            "deleted_by": result["deleted_by"],
        },
    )
    return result


@app.post("/api/chats/{chat_id}/read")
async def mark_read(chat_id: int, user=Depends(get_current_user)):
    if not db.is_chat_member(chat_id, user["id"]):
        raise HTTPException(status_code=403, detail="Ruxsat yo'q")
    if user["ghost_enabled"] and user["hide_read_receipts"]:
        return {"ghost_blocked": True, "read_ids": []}
    read_ids = db.mark_chat_read(chat_id, user["id"])
    if read_ids:
        await manager.broadcast_to_chat(
            chat_id,
            {
                "type": "messages_read",
                "chat_id": chat_id,
                "reader_id": user["id"],
                "message_ids": read_ids,
            },
        )
    return {"ghost_blocked": False, "read_ids": read_ids}


# ---------- File Upload & Download ----------
@app.post("/api/files/upload")
async def upload_file(file: UploadFile = File(...), user=Depends(get_current_user)):
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Bo'sh fayl yuklab bo'lmaydi")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Fayl hajmi 25 MB dan oshmasligi kerak")

    file_id = uuid.uuid4().hex
    original_name = Path(file.filename or "file").name
    ext = Path(original_name).suffix[:16]
    mime = file.content_type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"

    stored_path = db.UPLOAD_DIR / f"{file_id}{ext}"
    meta_path = db.UPLOAD_DIR / f"{file_id}.meta.json"
    stored_path.write_bytes(data)
    meta_path.write_text(
        json.dumps({"file_name": original_name, "file_mime": mime, "ext": ext, "size": len(data)}),
        encoding="utf-8",
    )

    return {
        "file_id": file_id,
        "file_name": original_name,
        "file_mime": mime,
        "file_size": len(data),
        "file_url": f"/api/files/{file_id}",
    }


@app.get("/api/files/{file_id}")
def get_file(file_id: str):
    if not re.match(r"^[a-f0-9]{32}$", file_id):
        raise HTTPException(status_code=400, detail="Noto'g'ri fayl ID")
    meta_path = db.UPLOAD_DIR / f"{file_id}.meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Fayl serverdan o'chirilgan")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    stored_path = db.UPLOAD_DIR / f"{file_id}{meta.get('ext', '')}"
    if not stored_path.exists():
        raise HTTPException(status_code=404, detail="Fayl topilmadi")
    return FileResponse(
        path=str(stored_path),
        media_type=meta.get("file_mime", "application/octet-stream"),
        filename=meta.get("file_name", file_id),
    )


# ---------- WebSocket Hub ----------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(default="")):
    payload = auth.verify_token(token)
    if not payload:
        await ws.close(code=4401)
        return
    user = db.get_user_by_id(payload["uid"])
    if not user:
        await ws.close(code=4401)
        return

    user_id = user["id"]
    await manager.connect(user_id, ws)
    if not (user["ghost_enabled"] and user["hide_online"]):
        db.touch_last_seen(user_id)
    await manager.broadcast_presence(user_id, True)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                event = json.loads(raw)
            except Exception:
                continue

            etype = event.get("type")

            if etype == "ping":
                await ws.send_json({"type": "pong", "ts": int(time.time())})

            elif etype == "live_draft":
                chat_id = event.get("chat_id")
                text = str(event.get("text", ""))[:2000]
                if not chat_id or not db.is_chat_member(int(chat_id), user_id):
                    continue
                fresh_user = db.get_user_by_id(user_id)
                if not fresh_user:
                    continue
                if (fresh_user["ghost_enabled"] and fresh_user["hide_typing"]) or not fresh_user["live_typing_share"]:
                    continue
                await manager.broadcast_to_chat(
                    int(chat_id),
                    {
                        "type": "live_draft",
                        "chat_id": int(chat_id),
                        "user_id": user_id,
                        "username": fresh_user["username"],
                        "display_name": fresh_user["display_name"],
                        "avatar_color": fresh_user["avatar_color"],
                        "text": text,
                        "ts": int(time.time() * 1000),
                    },
                    exclude_user_id=user_id,
                )

            elif etype == "send_message":
                chat_id = event.get("chat_id")
                content = str(event.get("content", "")).strip()
                reply_to_id = event.get("reply_to_id")
                if not chat_id or not content or not db.is_chat_member(int(chat_id), user_id):
                    continue
                msg = db.create_message(
                    chat_id=int(chat_id),
                    sender_id=user_id,
                    content=content,
                    reply_to_id=reply_to_id,
                )
                await manager.broadcast_to_chat(
                    int(chat_id),
                    {"type": "live_draft", "chat_id": int(chat_id), "user_id": user_id, "text": ""},
                    exclude_user_id=user_id,
                )
                await manager.broadcast_to_chat(int(chat_id), {"type": "new_message", "message": msg})

            elif etype == "mark_read":
                chat_id = event.get("chat_id")
                if not chat_id or not db.is_chat_member(int(chat_id), user_id):
                    continue
                fresh_user = db.get_user_by_id(user_id)
                if fresh_user and fresh_user["ghost_enabled"] and fresh_user["hide_read_receipts"]:
                    continue
                read_ids = db.mark_chat_read(int(chat_id), user_id)
                if read_ids:
                    await manager.broadcast_to_chat(
                        int(chat_id),
                        {
                            "type": "messages_read",
                            "chat_id": int(chat_id),
                            "reader_id": user_id,
                            "message_ids": read_ids,
                        },
                    )
    except WebSocketDisconnect:
        pass
    finally:
        fully_disconnected = manager.disconnect(user_id, ws)
        if fully_disconnected:
            fresh_user = db.get_user_by_id(user_id)
            if fresh_user and not (fresh_user["ghost_enabled"] and fresh_user["hide_online"]):
                db.touch_last_seen(user_id)
            await manager.broadcast_presence(user_id, False)


# ---------- Static Frontend (works both with static/ folder and flat root) ----------
ALLOWED_STATIC = {
    "style.css": "text/css",
    "app.js": "application/javascript",
    "manifest.json": "application/manifest+json",
}


@app.get("/static/{filename}")
def static_asset(filename: str):
    if filename not in ALLOWED_STATIC:
        raise HTTPException(status_code=404, detail="Fayl topilmadi")
    path = STATIC_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Fayl topilmadi")
    return FileResponse(str(path), media_type=ALLOWED_STATIC[filename])


@app.get("/manifest.json")
def manifest():
    return FileResponse(str(STATIC_DIR / "manifest.json"), media_type="application/manifest+json")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))
