/** Bounds-checked protobuf wire reader; every loop consumes bytes or throws. */
export class ProtoReader {
  offset = 0;
  constructor(readonly buffer: Buffer) {}
  get done(): boolean { return this.offset === this.buffer.length; }
  varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.bytes(1)[0]!;
      if (i === 9 && byte > 1) throw new TypeError("Protobuf varint exceeds 64 bits.");
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new TypeError("Invalid protobuf varint.");
  }
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.buffer.length - this.offset) throw new TypeError("Truncated protobuf field.");
    const result = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  delimited(): Buffer {
    const length = this.varint();
    if (length > BigInt(this.buffer.length - this.offset)) throw new TypeError("Truncated protobuf field.");
    return this.bytes(Number(length));
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.bytes(8);
    else if (wire === 2) this.delimited();
    else if (wire === 5) this.bytes(4);
    else throw new TypeError("Unsupported protobuf wire type.");
  }
}
