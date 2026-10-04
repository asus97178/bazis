export {
  WebSocketGateway,
  SubscribeMessage,
  getWebSocketGatewayMetadata,
  getGatewayMessageHandlers,
  normalizeNamespace,
  resolveWebSocketGatewayOptions,
  type WebSocketGatewayOptions,
  type SubscribeMessageOptions,
  type ResolvedGatewayOptions,
  type MessageHandlerDecl,
  type WsRateLimit,
  type WsBodyValidator,
} from "./decorators";
export type {
  ClientPacket,
  ServerPacket,
  ReconnectPacketData,
  ReplayDelivery,
  ReplayAcknowledgement,
  SocketUser,
  SocketContext,
  AckCallback,
  SocketBroadcast,
  OsnovaSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayShutdown,
} from "./types";
export {
  composeWsUpgradeMiddleware,
  createOriginCheckMiddleware,
  createWsAuthMiddleware,
  extractWebSocketToken,
  WsUpgradeError,
  type WsMiddleware,
  type WsUpgradeContext,
  type WsAccessTokenAuthenticator,
  type WsAuthenticationContext,
} from "./middleware";
export { WsRateLimiter, type WsRateLimiterOptions, type WsRateLimiterStats } from "./WsRateLimiter";
export { WebSocketExplorer, type CompiledWsHandler, type RegisteredNamespace } from "./explorer";
export {
  WebSocketServer,
  type WebSocketMemoryLimits,
  type WebSocketServerOptions,
  type WebSocketServerStats,
  type WsConnectionData,
} from "./ws-server";
export { websocketModule, type WebSocketModuleConfig } from "./websocketModule";
export { TopicCache, topicCache, type TopicCacheOptions, type TopicCacheStats } from "./topic-cache";
export {
  encodeServerPacket,
  decodeClientPacket,
  createAckPacket,
  createConnectedPacket,
  createReconnectedPacket,
  PacketCodecError,
} from "./packet-codec";
export { OsnovaSocketImpl, wrapSocket, restoreRoomSubscriptions, detachRoomSubscriptions, sendPayload } from "./socket-wrapper";
export {
  SessionManager,
  SessionCapacityError,
  type SessionState,
  type SessionManagerOptions,
  type OfflineBroadcastResult,
} from "./session-manager";
export type { WebSocketAdapter, WebSocketAdapterHooks } from "./adapter/adapter.interface";
export { InMemoryWebSocketAdapter, inMemoryWebSocketAdapter, type InMemoryWebSocketAdapterOptions } from "./adapter/in-memory.adapter";
export { RedisWebSocketAdapter, type RedisWebSocketAdapterOptions } from "./adapter/redis.adapter";
export type { RedisReliableDeliveryOptions } from "./adapter/redis-delivery-store";
export { WebSocketDeliveryError } from "./reliable-delivery";
export type { ReliableBroadcastOptions, ReliableBroadcastReceipt, ReliableRoomPublication, ReliableSessionOwner, ReliableDeliveryBatch, ReliableRoomDelivery, WebSocketDiagnostic } from "./reliable-delivery";
export { createInstanceId } from "./adapter/adapter.interface";
export type { PacketCodec } from "./codec/packet-codec.interface";
export { JsonPacketCodec, jsonPacketCodec } from "./codec/json.codec";
export { BinaryPacketCodec, binaryPacketCodec } from "./codec/binary.codec";
