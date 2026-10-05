import type { ClientPacket, ServerPacket } from "../types";
import { PacketCodecError } from "../packet-codec";
import type { PacketCodec } from "./packet-codec.interface";

/** Binary wire format: 0x01 magic + uint32be length + UTF-8 JSON body */
const MAGIC = 0x01;
const HEADER_SIZE = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function wrapJson(json: string): Uint8Array {
  const body = encoder.encode(json);
  const frame = new Uint8Array(HEADER_SIZE + body.length);
  frame[0] = MAGIC;
  new DataView(frame.buffer).setUint32(1, body.length, false);
  frame.set(body, HEADER_SIZE);
  return frame;
}

function unwrapJson(raw: string | Buffer | Uint8Array): string {
  const bytes =
    typeof raw === "string"
      ? encoder.encode(raw)
      : raw instanceof Buffer
        ? new Uint8Array(raw)
        : raw;

  if (bytes.length < HEADER_SIZE || bytes[0] !== MAGIC) {
    throw new PacketCodecError("Invalid binary packet frame");
  }

  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  const end = HEADER_SIZE + length;
  if (end > bytes.length) {
    throw new PacketCodecError("Truncated binary packet frame");
  }

  return decoder.decode(bytes.subarray(HEADER_SIZE, end));
}

export class BinaryPacketCodec implements PacketCodec {
  readonly name = "binary";

  encodeServer(packet: Omit<ServerPacket, "v"> & { v?: 1 }): Uint8Array {
    return wrapJson(JSON.stringify({ v: 1, ...packet }));
  }

  encodeClient(packet: Omit<ClientPacket, "v"> & { v?: 1 }): Uint8Array {
    return wrapJson(JSON.stringify({ v: 1, ...packet }));
  }

  decodeClient(raw: string | Buffer | Uint8Array): ClientPacket {
    const text = unwrapJson(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PacketCodecError("Invalid JSON in binary frame");
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

  isBinary(raw: string | Buffer | Uint8Array): boolean {
    if (typeof raw === "string") {
      return false;
    }
    const bytes = raw instanceof Buffer ? new Uint8Array(raw) : raw;
    return bytes.length > 0 && bytes[0] === MAGIC;
  }
}

export const binaryPacketCodec = new BinaryPacketCodec();
