/**
 * DisconnectReason Mapping
 *
 * Maps WhatsApp/Baileys disconnect status codes to human-readable information.
 * Used for logging and displaying disconnection causes in Health Monitor Dashboard.
 */

export interface DisconnectReasonInfo {
  name: string;
  description: string;
  recoverable: boolean;
}

/**
 * Baileys DisconnectReason enum values:
 * - loggedOut = 401
 * - forbidden = 403
 * - connectionLost = 408
 * - timedOut = 408
 * - connectionClosed = 428
 * - badSession = 500
 * - restartRequired = 515
 * - multideviceMismatch = 411
 * - unavailableService = 503
 */
export const DisconnectReasonMap: Record<number, DisconnectReasonInfo> = {
  401: {
    name: 'loggedOut',
    description: 'User logged out from WhatsApp',
    recoverable: false,
  },
  402: {
    name: 'paymentRequired',
    description: 'Payment required (business account)',
    recoverable: false,
  },
  403: {
    name: 'forbidden',
    description: 'Access denied by WhatsApp',
    recoverable: false,
  },
  406: {
    name: 'notAcceptable',
    description: 'Request not acceptable',
    recoverable: false,
  },
  408: {
    name: 'connectionLost',
    description: 'Connection timeout / lost',
    recoverable: true,
  },
  411: {
    name: 'multideviceMismatch',
    description: 'Multi-device conflict',
    recoverable: true,
  },
  428: {
    name: 'connectionClosed',
    description: 'WebSocket connection closed',
    recoverable: true,
  },
  440: {
    name: 'loginRequired',
    description: 'Login required (session expired)',
    recoverable: false,
  },
  500: {
    name: 'badSession',
    description: 'Session corrupted or invalid',
    recoverable: true,
  },
  503: {
    name: 'unavailableService',
    description: 'WhatsApp service unavailable',
    recoverable: true,
  },
  515: {
    name: 'restartRequired',
    description: 'Restart required by WhatsApp',
    recoverable: true,
  },
};

/**
 * Get disconnect reason information from status code
 * @param statusCode The Baileys/WhatsApp disconnect status code
 * @returns DisconnectReasonInfo with name, description, and recoverability
 */
export function getDisconnectReasonInfo(statusCode: number | undefined): DisconnectReasonInfo {
  if (statusCode === undefined || statusCode === null) {
    return {
      name: 'unknown',
      description: 'Unknown disconnection (no status code)',
      recoverable: true,
    };
  }

  return (
    DisconnectReasonMap[statusCode] || {
      name: 'unknown',
      description: `Unknown error (code: ${statusCode})`,
      recoverable: true,
    }
  );
}

/**
 * Check if a status code represents a definitive (non-recoverable) disconnection
 * @param statusCode The disconnect status code
 * @returns true if the disconnection is definitive and should not reconnect
 */
export function isDefinitiveDisconnect(statusCode: number | undefined): boolean {
  if (statusCode === undefined || statusCode === null) {
    return false;
  }

  const info = DisconnectReasonMap[statusCode];
  return info ? !info.recoverable : false;
}
