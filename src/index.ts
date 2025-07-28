/**
 * The Most Advanced Conceivable MTProto Cloudflare Worker Wizard
 * 
 * A sophisticated Telegram MTProto proxy implementation using Cloudflare Workers
 * with advanced features including:
 * 
 * - Full MTProto 2.0 protocol support
 * - Advanced encryption and security
 * - DDoS protection and rate limiting
 * - Multi-datacenter support with load balancing
 * - Real-time analytics and monitoring
 * - WebSocket support for bidirectional communication
 * - Session management with persistence
 * - Connection pooling and optimization
 * - Geographic analytics and routing
 * 
 * @author MTProto Wizard Team
 * @version 1.0.0
 */

import { Env } from './types';
import { MTProtoHandler } from './handlers/mtproto-handler';
import { ConnectionManager } from './lib/connection-manager';
import { Utils } from './utils';

/**
 * Main Worker entry point
 */
export default {
  /**
   * Handle incoming requests
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    
    try {
      Utils.debug(`Incoming request: ${request.method} ${request.url}`);
      
      // Initialize handler
      const handler = new MTProtoHandler(env);
      
      // Process request
      const response = await handler.handleRequest(request);
      
      // Add performance headers
      const processingTime = Date.now() - startTime;
      response.headers.set('X-Processing-Time', `${processingTime}ms`);
      response.headers.set('X-Worker-Version', '1.0.0');
      response.headers.set('X-Powered-By', 'MTProto Cloudflare Worker Wizard');
      
      Utils.debug(`Request processed in ${processingTime}ms`);
      
      return response;
      
    } catch (error) {
      Utils.debug(`Unhandled error: ${error}`);
      
      // Return generic error response
      return Utils.createErrorResponse(
        new Error('Internal server error'),
        500
      );
    }
  },

  /**
   * Handle scheduled events (cron jobs)
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    Utils.debug(`Scheduled event triggered: ${event.cron}`);
    
    try {
      // Run maintenance tasks
      await runMaintenanceTasks(env);
      
    } catch (error) {
      Utils.debug(`Scheduled event error: ${error}`);
    }
  }
};

/**
 * Export Durable Object for connection management
 */
export { ConnectionManager };

/**
 * Run periodic maintenance tasks
 */
async function runMaintenanceTasks(env: Env): Promise<void> {
  Utils.debug('Running maintenance tasks...');
  
  try {
    // Initialize managers
    const { SessionManager } = await import('./lib/session-manager');
    const { SecurityManager, Analytics } = await import('./utils');
    
    const sessionManager = new SessionManager(env);
    const security = new SecurityManager(env);
    const analytics = new Analytics(env);
    
    // Cleanup expired sessions
    const cleanedSessions = await sessionManager.cleanupExpiredSessions();
    Utils.debug(`Cleaned up ${cleanedSessions} expired sessions`);
    
    // Cleanup old connection info
    const cleanedConnections = await security.cleanupConnectionInfo();
    Utils.debug(`Cleaned up ${cleanedConnections} old connections`);
    
    // Track maintenance event
    await analytics.trackEvent({
      type: 'performance',
      timestamp: Date.now(),
      bytes: cleanedSessions + cleanedConnections
    });
    
    Utils.debug('Maintenance tasks completed');
    
  } catch (error) {
    Utils.debug(`Maintenance task error: ${error}`);
  }
}

/**
 * Environment configuration validation
 */
export function validateEnvironment(env: Env): void {
  const requiredVars = [
    'TELEGRAM_DC1',
    'TELEGRAM_DC2', 
    'TELEGRAM_DC3',
    'TELEGRAM_DC4',
    'TELEGRAM_DC5',
    'MAX_CONNECTIONS_PER_IP',
    'RATE_LIMIT_RPM',
    'SESSION_TIMEOUT'
  ];
  
  for (const varName of requiredVars) {
    if (!env[varName as keyof Env]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }
  
  const requiredBindings = [
    'SESSIONS',
    'ANALYTICS', 
    'CONFIG',
    'CONNECTION_MANAGER',
    'METRICS'
  ];
  
  for (const binding of requiredBindings) {
    if (!env[binding as keyof Env]) {
      throw new Error(`Missing required binding: ${binding}`);
    }
  }
}