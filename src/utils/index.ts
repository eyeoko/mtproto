import { AnalyticsEvent, ConnectionInfo, Env } from '../types';

/**
 * Rate limiting utilities with advanced features
 */
export class RateLimiter {
  private env: Env;
  private readonly RATE_LIMIT_PREFIX = 'rate_limit:';

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Check and update rate limit for IP address
   */
  async checkRateLimit(ip: string): Promise<boolean> {
    const key = `${this.RATE_LIMIT_PREFIX}${ip}`;
    const limit = parseInt(this.env.RATE_LIMIT_RPM);
    const window = 60; // 1 minute window
    
    try {
      const current = await this.env.SESSIONS.get(key, { type: 'json' }) || { count: 0, timestamp: Date.now() };
      const data = current as { count: number; timestamp: number };
      const now = Date.now();
      
      // Reset counter if window has passed
      if (now - data.timestamp >= window * 1000) {
        data.count = 0;
        data.timestamp = now;
      }
      
      // Check limit
      if (data.count >= limit) {
        return false;
      }
      
      // Increment counter
      data.count++;
      
      // Store updated counter
      await this.env.SESSIONS.put(key, JSON.stringify(data), { expirationTtl: window * 2 });
      
      return true;
    } catch (error) {
      console.error('Rate limit check failed:', error);
      return true; // Allow on error to prevent service disruption
    }
  }

  /**
   * Get current rate limit status
   */
  async getRateLimitStatus(ip: string): Promise<{ remaining: number; resetTime: number }> {
    const key = `${this.RATE_LIMIT_PREFIX}${ip}`;
    const limit = parseInt(this.env.RATE_LIMIT_RPM);
    
    try {
      const current = await this.env.SESSIONS.get(key, { type: 'json' }) || { count: 0, timestamp: Date.now() };
      const data = current as { count: number; timestamp: number };
      const window = 60 * 1000; // 1 minute in ms
      
      const remaining = Math.max(0, limit - data.count);
      const resetTime = data.timestamp + window;
      
      return { remaining, resetTime };
    } catch (error) {
      console.error('Failed to get rate limit status:', error);
      return { remaining: limit, resetTime: Date.now() + 60000 };
    }
  }
}

/**
 * Analytics and monitoring utilities
 */
export class Analytics {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Track analytics event
   */
  async trackEvent(event: AnalyticsEvent): Promise<void> {
    try {
      // Store in Analytics Engine
      this.env.METRICS.writeDataPoint({
        blobs: [event.type, event.sessionId || '', event.dcId?.toString() || ''],
        doubles: [event.latency || 0, event.bytes || 0],
        indexes: [event.clientIp || '', event.country || '']
      });

      // Also store in KV for detailed analytics
      const key = `analytics:${event.type}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      await this.env.ANALYTICS.put(key, JSON.stringify(event), { expirationTtl: 86400 * 7 }); // 7 days
    } catch (error) {
      console.error('Failed to track analytics event:', error);
    }
  }

  /**
   * Get analytics summary
   */
  async getAnalyticsSummary(timeframe: number = 3600): Promise<{
    totalConnections: number;
    totalMessages: number;
    totalErrors: number;
    avgLatency: number;
    topCountries: Array<{ country: string; count: number }>;
  }> {
    const cutoff = Date.now() - (timeframe * 1000);
    const events: AnalyticsEvent[] = [];
    
    try {
      // Fetch recent events from KV
      const list = await this.env.ANALYTICS.list({ prefix: 'analytics:' });
      
      for (const key of list.keys) {
        const timestamp = parseInt(key.name.split(':')[2] || '0');
        if (timestamp >= cutoff) {
          const event = await this.env.ANALYTICS.get(key.name, { type: 'json' });
          if (event) {
            events.push(event as AnalyticsEvent);
          }
        }
      }

      // Calculate summary
      const connections = events.filter(e => e.type === 'connection').length;
      const messages = events.filter(e => e.type === 'message').length;
      const errors = events.filter(e => e.type === 'error').length;
      
      const latencies = events.filter(e => e.latency).map(e => e.latency!);
      const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
      
      const countryCount: Record<string, number> = {};
      events.forEach(e => {
        if (e.country) {
          countryCount[e.country] = (countryCount[e.country] || 0) + 1;
        }
      });
      
      const topCountries = Object.entries(countryCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([country, count]) => ({ country, count }));

      return {
        totalConnections: connections,
        totalMessages: messages,
        totalErrors: errors,
        avgLatency,
        topCountries
      };
    } catch (error) {
      console.error('Failed to get analytics summary:', error);
      return {
        totalConnections: 0,
        totalMessages: 0,
        totalErrors: 0,
        avgLatency: 0,
        topCountries: []
      };
    }
  }
}

/**
 * Security and DDoS protection utilities
 */
export class SecurityManager {
  private env: Env;
  private readonly CONNECTION_PREFIX = 'connection:';

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Check if IP is allowed to connect
   */
  async checkConnectionPermission(ip: string, userAgent: string, country: string): Promise<boolean> {
    try {
      // Check connection count per IP
      const connectionInfo = await this.getConnectionInfo(ip);
      const maxConnections = parseInt(this.env.MAX_CONNECTIONS_PER_IP);
      
      if (connectionInfo.connectionCount >= maxConnections) {
        return false;
      }

      // Update connection info
      await this.updateConnectionInfo(ip, {
        ...connectionInfo,
        userAgent,
        country,
        connectionCount: connectionInfo.connectionCount + 1,
        lastSeen: Date.now()
      });

      return true;
    } catch (error) {
      console.error('Connection permission check failed:', error);
      return true; // Allow on error
    }
  }

  /**
   * Get connection information for IP
   */
  async getConnectionInfo(ip: string): Promise<ConnectionInfo> {
    try {
      const data = await this.env.SESSIONS.get(`${this.CONNECTION_PREFIX}${ip}`, { type: 'json' });
      
      if (data) {
        return data as ConnectionInfo;
      }
      
      return {
        ip,
        userAgent: '',
        country: '',
        connectionCount: 0,
        lastSeen: 0,
        rateLimitCounter: 0
      };
    } catch (error) {
      console.error('Failed to get connection info:', error);
      return {
        ip,
        userAgent: '',
        country: '',
        connectionCount: 0,
        lastSeen: 0,
        rateLimitCounter: 0
      };
    }
  }

  /**
   * Update connection information
   */
  async updateConnectionInfo(ip: string, info: ConnectionInfo): Promise<void> {
    try {
      await this.env.SESSIONS.put(
        `${this.CONNECTION_PREFIX}${ip}`,
        JSON.stringify(info),
        { expirationTtl: 3600 } // 1 hour TTL
      );
    } catch (error) {
      console.error('Failed to update connection info:', error);
    }
  }

  /**
   * Cleanup old connection info
   */
  async cleanupConnectionInfo(): Promise<number> {
    const cutoff = Date.now() - (3600 * 1000); // 1 hour ago
    let cleanedCount = 0;

    try {
      const list = await this.env.SESSIONS.list({ prefix: this.CONNECTION_PREFIX });
      
      for (const key of list.keys) {
        const info = await this.env.SESSIONS.get(key.name, { type: 'json' });
        
        if (info && (info as ConnectionInfo).lastSeen < cutoff) {
          await this.env.SESSIONS.delete(key.name);
          cleanedCount++;
        }
      }

      return cleanedCount;
    } catch (error) {
      console.error('Failed to cleanup connection info:', error);
      return 0;
    }
  }

  /**
   * Check for suspicious activity patterns
   */
  async detectSuspiciousActivity(ip: string): Promise<{
    isSuspicious: boolean;
    reason?: string;
    riskScore: number;
  }> {
    try {
      const connectionInfo = await this.getConnectionInfo(ip);
      let riskScore = 0;
      const reasons: string[] = [];

      // High connection count
      if (connectionInfo.connectionCount > parseInt(this.env.MAX_CONNECTIONS_PER_IP) * 0.8) {
        riskScore += 30;
        reasons.push('High connection count');
      }

      // High rate limit counter
      if (connectionInfo.rateLimitCounter > 10) {
        riskScore += 40;
        reasons.push('Repeated rate limit violations');
      }

      // Suspicious user agent patterns
      if (connectionInfo.userAgent && (
        connectionInfo.userAgent.includes('bot') ||
        connectionInfo.userAgent.includes('crawler') ||
        connectionInfo.userAgent.length < 10
      )) {
        riskScore += 20;
        reasons.push('Suspicious user agent');
      }

      const isSuspicious = riskScore >= 50;

      return {
        isSuspicious,
        reason: reasons.join(', '),
        riskScore
      };
    } catch (error) {
      console.error('Failed to detect suspicious activity:', error);
      return { isSuspicious: false, riskScore: 0 };
    }
  }
}

/**
 * Utility functions for various operations
 */
export class Utils {
  /**
   * Get client IP from request
   */
  static getClientIP(request: Request): string {
    return request.headers.get('CF-Connecting-IP') || 
           request.headers.get('X-Forwarded-For')?.split(',')[0] || 
           '127.0.0.1';
  }

  /**
   * Get client country from Cloudflare headers
   */
  static getClientCountry(request: Request): string {
    return request.headers.get('CF-IPCountry') || 'Unknown';
  }

  /**
   * Get user agent from request
   */
  static getUserAgent(request: Request): string {
    return request.headers.get('User-Agent') || 'Unknown';
  }

  /**
   * Generate random hex string
   */
  static generateRandomHex(length: number): string {
    const bytes = new Uint8Array(length / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Validate MTProto message format
   */
  static validateMTProtoMessage(data: Uint8Array): boolean {
    if (data.length < 24) return false; // Minimum message size
    if (data.length % 4 !== 0) return false; // Must be 4-byte aligned
    return true;
  }

  /**
   * Create error response
   */
  static createErrorResponse(error: Error, status: number = 500): Response {
    return new Response(JSON.stringify({
      error: error.message,
      type: error.constructor.name,
      timestamp: Date.now()
    }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  /**
   * Create success response
   */
  static createSuccessResponse(data: any): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  /**
   * Log debug information
   */
  static debug(message: string, data?: any): void {
    // In Cloudflare Workers, we don't have process.env, use globalThis
    const debugMode = (globalThis as any).DEBUG_MODE === 'true';
    if (debugMode) {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data || '');
    }
  }
}