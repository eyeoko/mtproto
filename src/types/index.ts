// Environment bindings for Cloudflare Worker
export interface Env {
  // KV Namespaces
  SESSIONS: KVNamespace;
  ANALYTICS: KVNamespace;
  CONFIG: KVNamespace;
  
  // Durable Objects
  CONNECTION_MANAGER: DurableObjectNamespace;
  
  // Analytics Engine
  METRICS: AnalyticsEngineDataset;
  
  // Rate Limiter
  RATE_LIMITER: any;
  
  // Environment variables
  TELEGRAM_DC1: string;
  TELEGRAM_DC2: string;
  TELEGRAM_DC3: string;
  TELEGRAM_DC4: string;
  TELEGRAM_DC5: string;
  MAX_CONNECTIONS_PER_IP: string;
  RATE_LIMIT_RPM: string;
  SESSION_TIMEOUT: string;
  DEBUG_MODE: string;
}

// MTProto Protocol Types
export interface MTProtoMessage {
  messageId: string;
  seqNo: number;
  body: Uint8Array;
  length: number;
}

export interface MTProtoSession {
  sessionId: string;
  authKey: Uint8Array;
  serverSalt: Uint8Array;
  seqNo: number;
  messageId: string;
  timeOffset: number;
  dcId: number;
  userId?: number;
  lastActivity: number;
}

export interface ConnectionInfo {
  ip: string;
  userAgent: string;
  country: string;
  connectionCount: number;
  lastSeen: number;
  rateLimitCounter: number;
}

export interface TelegramDataCenter {
  id: number;
  host: string;
  port: number;
  ipv4: string;
  ipv6?: string;
  publicKey: string;
}

export interface ProxyConfig {
  secret?: string;
  promotedChannels?: string[];
  enableFallback: boolean;
  maxConnections: number;
  rateLimitRpm: number;
  sessionTimeout: number;
  debugMode: boolean;
}

export interface AnalyticsEvent {
  type: 'connection' | 'message' | 'error' | 'performance';
  timestamp: number;
  sessionId?: string;
  dcId?: number;
  messageType?: string;
  errorCode?: string;
  latency?: number;
  bytes?: number;
  clientIp?: string;
  country?: string;
}

export interface SecurityConfig {
  enableDDoSProtection: boolean;
  maxConnectionsPerIp: number;
  rateLimitWindow: number;
  rateLimitThreshold: number;
  enableIPWhitelist: boolean;
  whitelist: string[];
  enableGeoBlocking: boolean;
  blockedCountries: string[];
}

// Error types
export class MTProtoError extends Error {
  constructor(
    message: string,
    public code: number,
    public type: string = 'MTPROTO_ERROR'
  ) {
    super(message);
    this.name = 'MTProtoError';
  }
}

export class RateLimitError extends MTProtoError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT_ERROR');
    this.name = 'RateLimitError';
  }
}

export class AuthenticationError extends MTProtoError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, 'AUTH_ERROR');
    this.name = 'AuthenticationError';
  }
}

export class ConnectionError extends MTProtoError {
  constructor(message: string = 'Connection failed') {
    super(message, 503, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}