import crypto from 'node:crypto';
console.log(`base64:${crypto.randomBytes(32).toString('base64')}`);
