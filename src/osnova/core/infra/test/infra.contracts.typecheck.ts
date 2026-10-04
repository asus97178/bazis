import type { InfraConnector, LlmProviderAdapter } from "../index";

type Assert<T extends true> = T;
type HasNoKind<T> = "kind" extends keyof T ? false : true;

type ConnectorHasNoKind = Assert<HasNoKind<InfraConnector>>;
type AdapterHasNoKind = Assert<HasNoKind<LlmProviderAdapter>>;
