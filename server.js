const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;
const app = express();
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.redirect("/hub.html");
});

app.get("/healthz", (_req, res) => res.sendStatus(200));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function makeRoomCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createUniqueRoomCode() {
  let code = makeRoomCode();
  while (rooms.has(code)) {
    code = makeRoomCode();
  }
  return code;
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(roomCode, payload, exceptWs = null) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }
  room.participants.forEach((participant) => {
    if (participant !== exceptWs) {
      send(participant, payload);
    }
  });
}

function removeFromRoom(ws) {
  if (!ws.roomCode) {
    return;
  }

  const room = rooms.get(ws.roomCode);
  if (!room) {
    ws.roomCode = null;
    ws.role = null;
    return;
  }

  room.participants.delete(ws);
  if (room.hub === ws) {
    room.hub = null;
  }

  broadcastToRoom(ws.roomCode, {
    type: "participant_left",
    role: ws.role || "unknown"
  });

  if (room.participants.size === 0) {
    rooms.delete(ws.roomCode);
  }

  ws.roomCode = null;
  ws.role = null;
}

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on("message", async (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (_error) {
      send(ws, { type: "error", message: "Message JSON invalide." });
      return;
    }

    if (message.type === "create_room") {
      removeFromRoom(ws);

      const code = createUniqueRoomCode();
      const room = {
        hub: ws,
        participants: new Set([ws])
      };
      rooms.set(code, room);

      ws.roomCode = code;
      ws.role = "hub";

      const joinUrl = `${PUBLIC_BASE_URL}/player.html?room=${code}`;
      const qrDataUrl = await QRCode.toDataURL(joinUrl);

      send(ws, {
        type: "room_created",
        roomCode: code,
        joinUrl,
        qrDataUrl
      });
      return;
    }

    if (message.type === "join_room") {
      const roomCode = String(message.roomCode || "").toUpperCase();
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, { type: "error", message: "Room introuvable." });
        return;
      }

      removeFromRoom(ws);
      room.participants.add(ws);
      ws.roomCode = roomCode;
      ws.role = "player";

      send(ws, { type: "joined_room", roomCode });
      broadcastToRoom(
        roomCode,
        {
          type: "participant_joined",
          role: "player"
        },
        ws
      );
      return;
    }

    if (!ws.roomCode) {
      send(ws, { type: "error", message: "Vous devez rejoindre une room." });
      return;
    }

    broadcastToRoom(
      ws.roomCode,
      {
        type: "relay",
        fromRole: ws.role,
        roomCode: ws.roomCode,
        payload: message
      },
      ws
    );
  });

  ws.on("close", () => {
    removeFromRoom(ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serveur Agence actif sur ${PUBLIC_BASE_URL}`);
});
