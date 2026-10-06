import type { ClientPacket, ServerPacket } from "../types";
import {
  decodeClientPacket as decodeJsonClient,
  encodeClientPacket,
  encodeServerPacket,
  PacketCodecError,
} from "../packet-codec";
import type { PacketCodec } from "./packet-codec.interface";

export class JsonPacketCodec implements PacketCodec {
  readonly name = "json";

  encodeServer(packet: Omit<ServerPacket, "v"> & { v?: 1 }): string {
    return encodeServerPacket(packet);
  }

  encodeClient(packet: Omit<ClientPacket, "v"> & { v?: 1 }): string {
    return encodeClientPacket(packet);
  }

  decodeClient(raw: string | Buffer | Uint8Array): ClientPacket {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return decodeJsonClient(text);
  }

  isBinary(raw: string | Buffer | Uint8Array): boolean {
    void raw;
    return false;
  }
}

export const jsonPacketCodec = new JsonPacketCodec();

export { PacketCodecError };
