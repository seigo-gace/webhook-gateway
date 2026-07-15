import crypto from 'node:crypto';

const raw = crypto.randomBytes(32);
console.log(`base64:${raw.toString('base64')}`);
