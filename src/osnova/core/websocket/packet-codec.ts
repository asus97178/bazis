import type { ClientPacket, ServerPacket } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeServerPacket(packet: Omit<ServerPacket, "v"> & { v?: 1 }): string {
  return JSON.stringify({ v: 1 as const, ...packet });
}

export function encodeClientPacket(packet: Omit<ClientPacket, "v"> & { v?: 1 }): string {
  return JSON.stringify({ v: 1 as const, ...packet });
}

export function decodeClientPacket(raw: string | Buffer): ClientPacket {
  const text = typeof raw === "string" ? raw : decoder.decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PacketCodecError("Invalid JSON packet");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PacketCodecError("Packet must be a JSON object");
  }

  const packet = parsed as Partial<ClientPacket>;
  if (packet.v !== 1) {
    throw new PacketCodecError("Unsupported packet version");
  }

  if (packet.type !== "event" && packet.type !== "reconnect" && packet.type !== "ping" && packet.type !== "replay-ack") {
    throw new PacketCodecError(`Unknown packet type: ${String(packet.type)}`);
  }

  return packet as ClientPacket;
}

export function encodeServerPacketBytes(packet: Omit<ServerPacket, "v"> & { v?: 1 }): Uint8Array {
  return encoder.encode(encodeServerPacket(packet));
}

export class PacketCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PacketCodecError";
  }
}

export function createErrorPacket(message: string, id?: string): string {
  return encodeServerPacket({
    type: "error",
    data: { message },
    id,
  });
}

export function createAckPacket(id: string, data?: unknown): string {
  return encodeServerPacket({
    type: "ack",
    id,
    data,
  });
}

export function createConnectedPacket(sid: string, namespace: string, data?: unknown): string {
  return encodeServerPacket({
    type: "connected",
    sid,
    namespace,
    data,
  });
}

export function createPongPacket(): string {
  return encodeServerPacket({ type: "pong" });
}

export function createReconnectedPacket(
  sid: string,
  namespace: string,
  missed: ServerPacket[] = [],
  data?: unknown,
): string {
  return encodeServerPacket({
    type: "reconnected",
    sid,
    namespace,
    missed,
    data,
  });
}

export function createEventPacket(
  namespace: string,
  event: string,
  data?: unknown,
  id?: string,
): string {
  return encodeServerPacket({
    type: "event",
    namespace,
    event,
    data,
    id,
  });
}
