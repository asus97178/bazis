import type { ClientPacket, ServerPacket } from "../types";

export interface PacketCodec {
  readonly name: string;
  encodeServer(packet: Omit<ServerPacket, "v"> & { v?: 1 }): string | Uint8Array;
  encodeClient(packet: Omit<ClientPacket, "v"> & { v?: 1 }): string | Uint8Array;
  decodeClient(raw: string | Buffer | Uint8Array): ClientPacket;
  isBinary(raw: string | Buffer | Uint8Array): boolean;
}

export function payloadToBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

export function payloadToText(payload: string | Uint8Array): string {
  return typeof payload === "string" ? payload : new TextDecoder().decode(payload);
}
