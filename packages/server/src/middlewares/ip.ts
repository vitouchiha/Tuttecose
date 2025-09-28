import { Request, Response, NextFunction } from 'express';
import { createLogger, Env } from '@aiostreams/core';

const logger = createLogger('server');

const isIpInRange = (ip: string, range: string) => {
  if (range.includes('/')) {
    // CIDR notation
    const [rangeIp, prefixLength] = range.split('/');
    const ipToLong = (ip: string) =>
      ip
        .split('.')
        .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    try {
      const ipLong = ipToLong(ip);
      const rangeLong = ipToLong(rangeIp);
      const mask = ~(2 ** (32 - parseInt(prefixLength, 10)) - 1) >>> 0;
      return (ipLong & mask) === (rangeLong & mask);
    } catch {
      return false;
    }
  }
  // Exact match
  return ip === range;
};

const isPrivateIp = (ip?: string) => {
  if (!ip) {
    return false;
  }
  return /^(10\.|(::ffff:)?127\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|::1)/.test(
    ip
  );
};

export const ipMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const getIpFromHeaders = (req: Request) => {
    return (
      req.get('X-Client-IP') ||
      req.get('X-Forwarded-For')?.split(',')[0].trim() ||
      req.get('X-Real-IP') ||
      req.get('CF-Connecting-IP') ||
      req.get('True-Client-IP') ||
      req.get('X-Forwarded')?.split(',')[0].trim() ||
      req.get('Forwarded-For')?.split(',')[0].trim() ||
      req.ip
    );
  };
  // extract IP from headers
  const userIp = getIpFromHeaders(req);
  const ip = req.ip || '';
  const trustedIps = Env.TRUSTED_IPS || [];

  const isTrustedIp = trustedIps.some((range) => isIpInRange(ip, range));
  const requestIp = isTrustedIp
    ? req.get('X-Forwarded-For')?.split(',')[0].trim() ||
      req.get('CF-Connecting-IP') ||
      ip
    : ip;
  req.userIp = isPrivateIp(userIp) ? undefined : userIp;
  req.requestIp = requestIp;
  next();
};
