import { Env, MTProtoSession } from '../types';
import { SessionManager } from './session-manager';
import { Analytics, SecurityManager, Utils } from '../utils';

/**
 * Advanced Connection Manager using Cloudflare Durable Objects
 * Handles persistent connections, load balancing, and failover
 */
export class ConnectionManager {
  private env: Env;
  private sessions: Map<string, WebSocket> = new Map();
  private sessionManager: SessionManager;
  private analytics: Analytics;
  private security: SecurityManager;
  private telegramSockets: Map<number, WebSocket> = new Map();

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
    this.sessionManager = new SessionManager(env);
    this.analytics = new Analytics(env);
    this.security = new SecurityManager(env);
    this.setupCleanupInterval();
  }

  /**
   * Handle incoming WebSocket connection
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Get client information
    const clientIP = Utils.getClientIP(request);
    const country = Utils.getClientCountry(request);
    const userAgent = Utils.getUserAgent(request);

    // Security checks
    const connectionAllowed = await this.security.checkConnectionPermission(clientIP, userAgent, country);
    if (!connectionAllowed) {
      return new Response('Too many connections', { status: 429 });
    }

    const suspiciousActivity = await this.security.detectSuspiciousActivity(clientIP);
    if (suspiciousActivity.isSuspicious) {
      Utils.debug(`Suspicious activity detected from ${clientIP}: ${suspiciousActivity.reason}`);
      
      await this.analytics.trackEvent({
        type: 'error',
        timestamp: Date.now(),
        errorCode: 'SUSPICIOUS_ACTIVITY',
        clientIp: clientIP,
        country
      });

      return new Response('Connection rejected', { status: 403 });
    }

    // Create WebSocket pair
    const [client, server] = Object.values(new WebSocketPair());

    // Accept the WebSocket connection
    server!.accept();

    // Handle the connection
    this.handleWebSocketConnection(server!, clientIP, country);

    return new Response(null, {
      status: 101,
      webSocket: client!,
    });
  }

  /**
   * Handle WebSocket connection lifecycle
   */
  private async handleWebSocketConnection(
    webSocket: WebSocket,
    clientIP: string,
    country: string
  ): Promise<void> {
    const connectionId = Utils.generateRandomHex(16);
    let currentSession: MTProtoSession | null = null;

    // Track analytics
    await this.analytics.trackEvent({
      type: 'connection',
      timestamp: Date.now(),
      clientIp: clientIP,
      country
    });

    Utils.debug(`New WebSocket connection: ${connectionId} from ${clientIP}`);

    webSocket.addEventListener('message', async (event) => {
      try {
        const startTime = Date.now();
        
        if (typeof event.data === 'string') {
          // Handle control messages
          const message = JSON.parse(event.data);
          await this.handleControlMessage(webSocket, message);
        } else {
          // Handle binary MTProto data
          const binaryData = new Uint8Array(event.data as ArrayBuffer);
          
          if (!Utils.validateMTProtoMessage(binaryData)) {
            throw new Error('Invalid MTProto message format');
          }

          await this.handleMTProtoMessage(
            binaryData,
            currentSession,
            clientIP,
            country
          );

          // Update currentSession if it was created
          if (!currentSession) {
            // In a real implementation, you'd extract session info from the message
            currentSession = await this.sessionManager.createSession(1);
          }
        }

        // Track performance
        const latency = Date.now() - startTime;
        const trackingEvent: any = {
          type: 'performance',
          timestamp: Date.now(),
          latency,
          bytes: event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.length,
          clientIp: clientIP,
          country
        };
        if (currentSession?.sessionId) {
          trackingEvent.sessionId = currentSession.sessionId;
        }
        await this.analytics.trackEvent(trackingEvent);

      } catch (error) {
        Utils.debug(`Error handling message: ${error}`);
        
        const errorEvent: any = {
          type: 'error',
          timestamp: Date.now(),
          errorCode: 'MESSAGE_HANDLING_ERROR',
          clientIp: clientIP,
          country
        };
        if (currentSession?.sessionId) {
          errorEvent.sessionId = currentSession.sessionId;
        }
        await this.analytics.trackEvent(errorEvent);

        webSocket.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
        }));
      }
    });

    webSocket.addEventListener('close', async (event) => {
      Utils.debug(`WebSocket connection closed: ${connectionId}, code: ${event.code}`);
      
      // Clean up session
      this.sessions.delete(connectionId);
      
      if (currentSession) {
        await this.sessionManager.updateSession(currentSession);
      }

      // Track disconnection
      const disconnectEvent: any = {
        type: 'connection',
        timestamp: Date.now(),
        clientIp: clientIP,
        country
      };
      if (currentSession?.sessionId) {
        disconnectEvent.sessionId = currentSession.sessionId;
      }
      await this.analytics.trackEvent(disconnectEvent);
    });

    webSocket.addEventListener('error', async (event) => {
      Utils.debug(`WebSocket error: ${connectionId}`, event);
      
      const wsErrorEvent: any = {
        type: 'error',
        timestamp: Date.now(),
        errorCode: 'WEBSOCKET_ERROR',
        clientIp: clientIP,
        country
      };
      if (currentSession?.sessionId) {
        wsErrorEvent.sessionId = currentSession.sessionId;
      }
      await this.analytics.trackEvent(wsErrorEvent);
    });

    // Store connection
    this.sessions.set(connectionId, webSocket);
  }

  /**
   * Handle control messages (JSON)
   */
  private async handleControlMessage(
    webSocket: WebSocket,
    message: any
  ): Promise<void> {
    switch (message.type) {
      case 'ping':
        webSocket.send(JSON.stringify({
          type: 'pong',
          timestamp: Date.now()
        }));
        break;

      case 'get_stats': {
        const stats = await this.getConnectionStats();
        webSocket.send(JSON.stringify({
          type: 'stats',
          data: stats
        }));
        break;
      }

      case 'get_session_info':
        if (message.sessionId) {
          const session = await this.sessionManager.getSession(message.sessionId);
          webSocket.send(JSON.stringify({
            type: 'session_info',
            data: session ? {
              sessionId: session.sessionId,
              dcId: session.dcId,
              lastActivity: session.lastActivity,
              userId: session.userId
            } : null
          }));
        }
        break;

      default:
        webSocket.send(JSON.stringify({
          type: 'error',
          message: 'Unknown control message type'
        }));
    }
  }

  /**
   * Handle MTProto binary messages
   */
  private async handleMTProtoMessage(
    data: Uint8Array,
    session: MTProtoSession | null,
    clientIP: string,
    country: string
  ): Promise<void> {
    try {
      // If no session, this might be an auth request
      if (!session) {
        session = await this.initializeSession();
        if (!session) {
          throw new Error('Failed to initialize session');
        }
      }

      // Get or create connection to Telegram
      const telegramSocket = await this.getTelegramConnection(session.dcId);
      
      if (!telegramSocket || telegramSocket.readyState !== WebSocket.READY_STATE_OPEN) {
        throw new Error(`No connection to DC${session.dcId}`);
      }

      // Forward message to Telegram
      telegramSocket.send(data);

      // Update session activity
      await this.sessionManager.updateSession(session);

      // Track message
      await this.analytics.trackEvent({
        type: 'message',
        timestamp: Date.now(),
        sessionId: session.sessionId,
        dcId: session.dcId,
        bytes: data.length,
        clientIp: clientIP,
        country
      });

    } catch (error) {
      Utils.debug(`Error handling MTProto message: ${error}`);
      throw error;
    }
  }

  /**
   * Initialize new session from auth data
   */
  private async initializeSession(): Promise<MTProtoSession | null> {
    try {
      // In a real implementation, this would parse the auth data to determine DC
      // For now, we'll use DC1 as default
      const dcId = 1;
      
      const session = await this.sessionManager.createSession(dcId);
      
      Utils.debug(`Initialized new session: ${session.sessionId} for DC${dcId}`);
      
      return session;
    } catch (error) {
      Utils.debug(`Failed to initialize session: ${error}`);
      return null;
    }
  }

  /**
   * Get or create connection to Telegram datacenter
   */
  private async getTelegramConnection(dcId: number): Promise<WebSocket | null> {
    try {
      // Check existing connection
      const existingSocket = this.telegramSockets.get(dcId);
      if (existingSocket && existingSocket.readyState === WebSocket.READY_STATE_OPEN) {
        return existingSocket;
      }

      // Create new connection
      const dcEndpoint = this.getTelegramEndpoint(dcId);
      if (!dcEndpoint) {
        throw new Error(`Unknown datacenter: ${dcId}`);
      }

      const socket = new WebSocket(dcEndpoint);
      
      socket.addEventListener('open', () => {
        Utils.debug(`Connected to Telegram DC${dcId}`);
        this.telegramSockets.set(dcId, socket);
      });

      socket.addEventListener('message', (event) => {
        // Forward message back to appropriate client
        this.forwardTelegramMessage(event.data);
      });

      socket.addEventListener('close', () => {
        Utils.debug(`Disconnected from Telegram DC${dcId}`);
        this.telegramSockets.delete(dcId);
      });

      socket.addEventListener('error', (error) => {
        Utils.debug(`Telegram DC${dcId} connection error:`, error);
        this.telegramSockets.delete(dcId);
      });

      return socket;
    } catch (error) {
      Utils.debug(`Failed to connect to Telegram DC${dcId}: ${error}`);
      return null;
    }
  }

  /**
   * Get Telegram datacenter endpoint
   */
  private getTelegramEndpoint(dcId: number): string | null {
    const endpoints: Record<number, string> = {
      1: `wss://${this.env.TELEGRAM_DC1.replace(':443', '')}`,
      2: `wss://${this.env.TELEGRAM_DC2.replace(':443', '')}`,
      3: `wss://${this.env.TELEGRAM_DC3.replace(':443', '')}`,
      4: `wss://${this.env.TELEGRAM_DC4.replace(':443', '')}`,
      5: `wss://${this.env.TELEGRAM_DC5.replace(':443', '')}`
    };

    return endpoints[dcId] || null;
  }

  /**
   * Forward message from Telegram to appropriate client
   */
  private async forwardTelegramMessage(data: any): Promise<void> {
    try {
      // In a real implementation, you'd parse the message to determine the target session
      // For now, we'll broadcast to all sessions for this DC
      const sessions = await this.getSessionsForDC();
      
      for (const session of sessions) {
        const clientSocket = this.findClientSocket();
        if (clientSocket && clientSocket.readyState === WebSocket.READY_STATE_OPEN) {
          clientSocket.send(data);
        }
      }
    } catch (error) {
      Utils.debug(`Error forwarding Telegram message: ${error}`);
    }
  }

  /**
   * Find client socket by session ID
   */
  private findClientSocket(): WebSocket | null {
    // This is simplified - in practice you'd maintain a mapping
    for (const [, socket] of this.sessions) {
      if (socket.readyState === WebSocket.READY_STATE_OPEN) {
        return socket;
      }
    }
    return null;
  }

  /**
   * Get active sessions for a datacenter
   */
  private async getSessionsForDC(): Promise<MTProtoSession[]> {
    // This would typically query the session manager
    // For now, return empty array
    return [];
  }

  /**
   * Get connection statistics
   */
  private async getConnectionStats(): Promise<{
    activeConnections: number;
    totalSessions: number;
    telegramConnections: number;
    memoryUsage: number;
  }> {
    const activeConnections = Array.from(this.sessions.values())
      .filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN).length;

    const telegramConnections = Array.from(this.telegramSockets.values())
      .filter(socket => socket.readyState === WebSocket.READY_STATE_OPEN).length;

    const sessionStats = await this.sessionManager.getSessionStats();

    return {
      activeConnections,
      totalSessions: sessionStats.totalSessions,
      telegramConnections,
      memoryUsage: this.sessions.size * 1024 // Rough estimate
    };
  }

  /**
   * Setup periodic cleanup
   */
  private setupCleanupInterval(): void {
    // Run cleanup every 5 minutes
    setInterval(async () => {
      try {
        await this.cleanup();
      } catch (error) {
        Utils.debug(`Cleanup error: ${error}`);
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Cleanup expired connections and sessions
   */
  private async cleanup(): Promise<void> {
    Utils.debug('Starting connection cleanup...');

    // Clean up closed WebSocket connections
    for (const [connectionId, socket] of this.sessions) {
      if (socket.readyState === WebSocket.READY_STATE_CLOSED) {
        this.sessions.delete(connectionId);
      }
    }

    // Clean up expired sessions
    const cleanedSessions = await this.sessionManager.cleanupExpiredSessions();
    
    // Clean up connection info
    const cleanedConnections = await this.security.cleanupConnectionInfo();

    Utils.debug(`Cleanup completed: ${cleanedSessions} sessions, ${cleanedConnections} connections`);
  }
}