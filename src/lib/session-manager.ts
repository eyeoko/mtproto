import { MTProtoSession, Env } from '../types';
import { MTProtoProtocol } from './mtproto';

/**
 * Advanced Session Manager for MTProto connections
 * Handles session lifecycle, persistence, and cleanup
 */
export class SessionManager {
  private env: Env;
  private readonly SESSION_PREFIX = 'session:';
  private readonly SESSION_INDEX_PREFIX = 'session_index:';

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Create a new MTProto session
   */
  async createSession(dcId: number, userId?: number): Promise<MTProtoSession> {
    const sessionId = MTProtoProtocol.generateSessionId();
    const authKey = MTProtoProtocol.generateAuthKey();
    const serverSalt = MTProtoProtocol.generateServerSalt();

    const session: MTProtoSession = {
      sessionId,
      authKey,
      serverSalt,
      seqNo: 0,
      messageId: MTProtoProtocol.generateMessageId(),
      timeOffset: 0,
      dcId,
      lastActivity: Date.now()
    };

    // Add userId only if provided
    if (userId !== undefined) {
      session.userId = userId;
    }

    // Store session in KV
    await this.storeSession(session);

    // Update session index for user
    if (userId) {
      await this.updateUserSessionIndex(userId, sessionId);
    }

    return session;
  }

  /**
   * Retrieve session by ID
   */
  async getSession(sessionId: string): Promise<MTProtoSession | null> {
    try {
      const sessionData = await this.env.SESSIONS.get(
        `${this.SESSION_PREFIX}${sessionId}`,
        { type: 'json' }
      );

      if (!sessionData) {
        return null;
      }

      // Convert stored arrays back to Uint8Array
      const session = sessionData as any;
      session.authKey = new Uint8Array(session.authKey);
      session.serverSalt = new Uint8Array(session.serverSalt);

      return session as MTProtoSession;
    } catch (error) {
      console.error('Failed to retrieve session:', error);
      return null;
    }
  }

  /**
   * Update session with new data
   */
  async updateSession(session: MTProtoSession): Promise<void> {
    session.lastActivity = Date.now();
    await this.storeSession(session);
  }

  /**
   * Delete session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    
    // Remove from KV storage
    await this.env.SESSIONS.delete(`${this.SESSION_PREFIX}${sessionId}`);

    // Remove from user index if applicable
    if (session?.userId) {
      await this.removeFromUserSessionIndex(session.userId, sessionId);
    }
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: number): Promise<MTProtoSession[]> {
    try {
      const indexData = await this.env.SESSIONS.get(
        `${this.SESSION_INDEX_PREFIX}${userId}`,
        { type: 'json' }
      );

      if (!indexData) {
        return [];
      }

      const sessionIds = indexData as string[];
      const sessions: MTProtoSession[] = [];

      for (const sessionId of sessionIds) {
        const session = await this.getSession(sessionId);
        if (session) {
          sessions.push(session);
        }
      }

      return sessions;
    } catch (error) {
      console.error('Failed to retrieve user sessions:', error);
      return [];
    }
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const sessionTimeout = parseInt(this.env.SESSION_TIMEOUT) * 1000; // Convert to ms
    const now = Date.now();
    let cleanedCount = 0;

    try {
      // List all session keys
      const list = await this.env.SESSIONS.list({ prefix: this.SESSION_PREFIX });
      
      for (const key of list.keys) {
        const session = await this.getSession(key.name.replace(this.SESSION_PREFIX, ''));
        
        if (session && (now - session.lastActivity) > sessionTimeout) {
          await this.deleteSession(session.sessionId);
          cleanedCount++;
        }
      }

      return cleanedCount;
    } catch (error) {
      console.error('Failed to cleanup expired sessions:', error);
      return 0;
    }
  }

  /**
   * Get session statistics
   */
  async getSessionStats(): Promise<{
    totalSessions: number;
    activeSessions: number;
    sessionsByDC: Record<number, number>;
  }> {
    const list = await this.env.SESSIONS.list({ prefix: this.SESSION_PREFIX });
    const sessionTimeout = parseInt(this.env.SESSION_TIMEOUT) * 1000;
    const now = Date.now();
    
    let activeSessions = 0;
    const sessionsByDC: Record<number, number> = {};

    for (const key of list.keys) {
      const session = await this.getSession(key.name.replace(this.SESSION_PREFIX, ''));
      
      if (session) {
        // Count by DC
        sessionsByDC[session.dcId] = (sessionsByDC[session.dcId] || 0) + 1;
        
        // Check if active
        if ((now - session.lastActivity) <= sessionTimeout) {
          activeSessions++;
        }
      }
    }

    return {
      totalSessions: list.keys.length,
      activeSessions,
      sessionsByDC
    };
  }

  /**
   * Validate session and check expiration
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    
    if (!session) {
      return false;
    }

    const sessionTimeout = parseInt(this.env.SESSION_TIMEOUT) * 1000;
    const now = Date.now();

    if ((now - session.lastActivity) > sessionTimeout) {
      // Session expired, clean it up
      await this.deleteSession(sessionId);
      return false;
    }

    return true;
  }

  /**
   * Store session in KV storage
   */
  private async storeSession(session: MTProtoSession): Promise<void> {
    // Convert Uint8Array to regular arrays for JSON serialization
    const sessionData = {
      ...session,
      authKey: Array.from(session.authKey),
      serverSalt: Array.from(session.serverSalt)
    };

    await this.env.SESSIONS.put(
      `${this.SESSION_PREFIX}${session.sessionId}`,
      JSON.stringify(sessionData),
      {
        expirationTtl: parseInt(this.env.SESSION_TIMEOUT) * 2 // Double timeout for safety
      }
    );
  }

  /**
   * Update user session index
   */
  private async updateUserSessionIndex(userId: number, sessionId: string): Promise<void> {
    const indexKey = `${this.SESSION_INDEX_PREFIX}${userId}`;
    
    try {
      const existingIndex = await this.env.SESSIONS.get(indexKey, { type: 'json' }) || [];
      const sessionIds = existingIndex as string[];
      
      if (!sessionIds.includes(sessionId)) {
        sessionIds.push(sessionId);
        
        await this.env.SESSIONS.put(
          indexKey,
          JSON.stringify(sessionIds),
          {
            expirationTtl: parseInt(this.env.SESSION_TIMEOUT) * 2
          }
        );
      }
    } catch (error) {
      console.error('Failed to update user session index:', error);
    }
  }

  /**
   * Remove session from user index
   */
  private async removeFromUserSessionIndex(userId: number, sessionId: string): Promise<void> {
    const indexKey = `${this.SESSION_INDEX_PREFIX}${userId}`;
    
    try {
      const existingIndex = await this.env.SESSIONS.get(indexKey, { type: 'json' });
      
      if (existingIndex) {
        const sessionIds = (existingIndex as string[]).filter(id => id !== sessionId);
        
        if (sessionIds.length > 0) {
          await this.env.SESSIONS.put(
            indexKey,
            JSON.stringify(sessionIds),
            {
              expirationTtl: parseInt(this.env.SESSION_TIMEOUT) * 2
            }
          );
        } else {
          await this.env.SESSIONS.delete(indexKey);
        }
      }
    } catch (error) {
      console.error('Failed to remove from user session index:', error);
    }
  }
}