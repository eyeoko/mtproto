import CryptoJS from 'crypto-js';
import { MTProtoMessage, MTProtoError } from '../types';

/**
 * Advanced MTProto 2.0 Protocol Implementation
 * Handles encryption, decryption, and message serialization for Telegram protocol
 */
export class MTProtoProtocol {
  private static readonly MESSAGE_ID_MULTIPLIER = 4294967296; // 2^32
  
  /**
   * Generate a new message ID based on current time
   */
  static generateMessageId(): string {
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const nanoseconds = (now % 1000) * 1000000;
    return (seconds * this.MESSAGE_ID_MULTIPLIER + nanoseconds).toString();
  }

  /**
   * Generate server salt for session
   */
  static generateServerSalt(): Uint8Array {
    const salt = new Uint8Array(8);
    crypto.getRandomValues(salt);
    return salt;
  }

  /**
   * Generate session ID
   */
  static generateSessionId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate auth key (simplified version for demo)
   * In production, this would involve Diffie-Hellman key exchange
   */
  static generateAuthKey(): Uint8Array {
    const key = new Uint8Array(256); // 2048-bit key
    crypto.getRandomValues(key);
    return key;
  }

  /**
   * Encrypt message using MTProto 2.0 encryption
   */
  static encryptMessage(
    message: Uint8Array,
    authKey: Uint8Array,
    serverSalt: Uint8Array,
    sessionId: string,
    messageId: string,
    seqNo: number
  ): Uint8Array {
    try {
      // Create message key from auth key and message
      const messageKey = this.createMessageKey(authKey, message);
      
      // Derive encryption keys
      const { aesKey, aesIv } = this.deriveKeys(authKey, messageKey, true);
      
      // Create inner data
      const innerData = this.createInnerData(
        serverSalt,
        sessionId,
        messageId,
        seqNo,
        message
      );
      
      // Pad message to 16-byte boundary
      const paddedData = this.padMessage(innerData);
      
      // Encrypt with AES-256-IGE
      const encrypted = this.aesIgeEncrypt(paddedData, aesKey, aesIv);
      
      // Create final message
      const result = new Uint8Array(8 + 16 + encrypted.length);
      result.set(authKey.slice(0, 8), 0); // auth_key_id
      result.set(messageKey, 8); // message_key
      result.set(encrypted, 24); // encrypted_data
      
      return result;
    } catch (error) {
      throw new MTProtoError(`Encryption failed: ${error}`, 500, 'ENCRYPTION_ERROR');
    }
  }

  /**
   * Decrypt message using MTProto 2.0 decryption
   */
  static decryptMessage(
    encryptedMessage: Uint8Array,
    authKey: Uint8Array
  ): MTProtoMessage {
    try {
      if (encryptedMessage.length < 24) {
        throw new MTProtoError('Invalid message length', 400, 'INVALID_MESSAGE');
      }

      // Extract components
      const messageKey = encryptedMessage.slice(8, 24);
      const encryptedData = encryptedMessage.slice(24);

      // Derive decryption keys
      const { aesKey, aesIv } = this.deriveKeys(authKey, messageKey, false);

      // Decrypt data
      const decrypted = this.aesIgeDecrypt(encryptedData, aesKey, aesIv);

      // Parse inner data
      const { messageId, seqNo, body } = this.parseInnerData(decrypted);

      return {
        messageId,
        seqNo,
        body,
        length: body.length
      };
    } catch (error) {
      throw new MTProtoError(`Decryption failed: ${error}`, 500, 'DECRYPTION_ERROR');
    }
  }

  /**
   * Create message key from auth key and message data
   */
  private static createMessageKey(authKey: Uint8Array, message: Uint8Array): Uint8Array {
    const authKeyPart = authKey.slice(88, 120); // 32 bytes from auth_key
    const data = new Uint8Array(authKeyPart.length + message.length);
    data.set(authKeyPart, 0);
    data.set(message, authKeyPart.length);
    
    const hash = CryptoJS.SHA256(CryptoJS.lib.WordArray.create(data));
    return new Uint8Array(hash.words.flatMap(word => [
      (word >>> 24) & 0xff,
      (word >>> 16) & 0xff,
      (word >>> 8) & 0xff,
      word & 0xff
    ])).slice(8, 24); // Take middle 16 bytes
  }

  /**
   * Derive AES key and IV from auth key and message key
   */
  private static deriveKeys(
    authKey: Uint8Array,
    messageKey: Uint8Array,
    isOutgoing: boolean
  ): { aesKey: Uint8Array; aesIv: Uint8Array } {
    const x = isOutgoing ? 0 : 8;
    
    // Create SHA256 inputs
    const sha256a = new Uint8Array(48);
    sha256a.set(messageKey, 0);
    sha256a.set(authKey.slice(x, x + 32), 16);
    
    const sha256b = new Uint8Array(48);
    sha256b.set(authKey.slice(x + 32, x + 48), 0);
    sha256b.set(messageKey, 16);
    sha256b.set(authKey.slice(x + 48, x + 64), 32);

    // Calculate hashes
    const hashA = CryptoJS.SHA256(CryptoJS.lib.WordArray.create(sha256a));
    const hashB = CryptoJS.SHA256(CryptoJS.lib.WordArray.create(sha256b));

    // Extract key and IV
    const aesKey = new Uint8Array(32);
    const aesIv = new Uint8Array(32);

    const hashABytes = new Uint8Array(hashA.words.flatMap(word => [
      (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff
    ]));
    
    const hashBBytes = new Uint8Array(hashB.words.flatMap(word => [
      (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff
    ]));

    aesKey.set(hashABytes.slice(0, 8), 0);
    aesKey.set(hashBBytes.slice(8, 24), 8);
    aesKey.set(hashABytes.slice(24, 32), 24);

    aesIv.set(hashBBytes.slice(0, 8), 0);
    aesIv.set(hashABytes.slice(8, 24), 8);
    aesIv.set(hashBBytes.slice(24, 32), 24);

    return { aesKey, aesIv };
  }

  /**
   * Create inner data structure for MTProto message
   */
  private static createInnerData(
    serverSalt: Uint8Array,
    sessionId: string,
    messageId: string,
    seqNo: number,
    message: Uint8Array
  ): Uint8Array {
    const sessionIdBytes = new Uint8Array(8);
    // Convert hex session ID to bytes
    for (let i = 0; i < 8; i++) {
      sessionIdBytes[i] = parseInt(sessionId.slice(i * 2, i * 2 + 2), 16);
    }

    const messageIdBytes = new Uint8Array(8);
    const messageIdNum = BigInt(messageId);
    for (let i = 0; i < 8; i++) {
      messageIdBytes[i] = Number((messageIdNum >> BigInt(i * 8)) & BigInt(0xff));
    }

    const seqNoBytes = new Uint8Array(4);
    seqNoBytes[0] = seqNo & 0xff;
    seqNoBytes[1] = (seqNo >>> 8) & 0xff;
    seqNoBytes[2] = (seqNo >>> 16) & 0xff;
    seqNoBytes[3] = (seqNo >>> 24) & 0xff;

    const lengthBytes = new Uint8Array(4);
    lengthBytes[0] = message.length & 0xff;
    lengthBytes[1] = (message.length >>> 8) & 0xff;
    lengthBytes[2] = (message.length >>> 16) & 0xff;
    lengthBytes[3] = (message.length >>> 24) & 0xff;

    const innerData = new Uint8Array(
      serverSalt.length + sessionIdBytes.length + messageIdBytes.length + 
      seqNoBytes.length + lengthBytes.length + message.length
    );

    let offset = 0;
    innerData.set(serverSalt, offset); offset += serverSalt.length;
    innerData.set(sessionIdBytes, offset); offset += sessionIdBytes.length;
    innerData.set(messageIdBytes, offset); offset += messageIdBytes.length;
    innerData.set(seqNoBytes, offset); offset += seqNoBytes.length;
    innerData.set(lengthBytes, offset); offset += lengthBytes.length;
    innerData.set(message, offset);

    return innerData;
  }

  /**
   * Parse inner data from decrypted message
   */
  private static parseInnerData(data: Uint8Array): {
    messageId: string;
    seqNo: number;
    body: Uint8Array;
  } {
    let offset = 8; // Skip server salt
    
    const sessionIdBytes = data.slice(offset, offset + 8);
    offset += 8;
    Array.from(sessionIdBytes, byte => 
      byte.toString(16).padStart(2, '0')
    ).join(''); // Calculate but don't use sessionId

    const messageIdBytes = data.slice(offset, offset + 8);
    offset += 8;
    let messageIdNum = BigInt(0);
    for (let i = 0; i < 8; i++) {
      const byte = messageIdBytes[i];
      if (byte !== undefined) {
        messageIdNum |= BigInt(byte) << BigInt(i * 8);
      }
    }
    const messageId = messageIdNum.toString();

    const seqNoBytes = data.slice(offset, offset + 4);
    offset += 4;
    const seqNo = (seqNoBytes[0] || 0) | 
                  ((seqNoBytes[1] || 0) << 8) | 
                  ((seqNoBytes[2] || 0) << 16) | 
                  ((seqNoBytes[3] || 0) << 24);

    const lengthBytes = data.slice(offset, offset + 4);
    offset += 4;
    const length = (lengthBytes[0] || 0) | 
                   ((lengthBytes[1] || 0) << 8) | 
                   ((lengthBytes[2] || 0) << 16) | 
                   ((lengthBytes[3] || 0) << 24);

    const body = data.slice(offset, offset + length);

    return { messageId, seqNo, body };
  }

  /**
   * Pad message to 16-byte boundary
   */
  private static padMessage(data: Uint8Array): Uint8Array {
    const padding = 16 - (data.length % 16);
    const padded = new Uint8Array(data.length + padding);
    padded.set(data, 0);
    
    // Fill padding with random bytes
    const paddingBytes = new Uint8Array(padding);
    crypto.getRandomValues(paddingBytes);
    padded.set(paddingBytes, data.length);
    
    return padded;
  }

  /**
   * AES-IGE encryption (simplified implementation)
   */
  private static aesIgeEncrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
    // This is a simplified implementation
    // In production, you'd use a proper AES-IGE implementation
    const cipher = CryptoJS.AES.encrypt(
      CryptoJS.lib.WordArray.create(data),
      CryptoJS.lib.WordArray.create(key),
      {
        iv: CryptoJS.lib.WordArray.create(iv),
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.NoPadding
      }
    );
    
    return new Uint8Array(cipher.ciphertext.words.flatMap(word => [
      (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff
    ]));
  }

  /**
   * AES-IGE decryption (simplified implementation)
   */
  private static aesIgeDecrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
    // This is a simplified implementation
    // In production, you'd use a proper AES-IGE implementation
    const decrypted = CryptoJS.AES.decrypt(
      CryptoJS.lib.CipherParams.create({
        ciphertext: CryptoJS.lib.WordArray.create(data)
      }),
      CryptoJS.lib.WordArray.create(key),
      {
        iv: CryptoJS.lib.WordArray.create(iv),
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.NoPadding
      }
    );
    
    return new Uint8Array(decrypted.words.flatMap(word => [
      (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff
    ]));
  }
}