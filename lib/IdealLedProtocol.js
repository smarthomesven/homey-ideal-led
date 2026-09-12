'use strict';

const crypto = require('crypto');

const SECRET_KEY = Buffer.from([
  0x34, 0x52, 0x2A, 0x5B, 0x7A, 0x6E, 0x49, 0x2C,
  0x08, 0x09, 0x0A, 0x9D, 0x8D, 0x2A, 0x23, 0xF8,
]);

const UUIDS = {
  SERVICE: '0000fff0-0000-1000-8000-00805f9b34fb',
  WRITE_CMD: 'd44bc439-abfd-45a2-b575-925416129600',
  WRITE_DATA: 'd44bc439-abfd-45a2-b575-92541612960a',
  NOTIFY: 'd44bc439-abfd-45a2-b575-925416129601',
};

function stripDashes(uuid) {
  return uuid.replace(/-/g, '');
}

function encrypt(packet) {
  const cipher = crypto.createCipheriv('aes-128-ecb', SECRET_KEY, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(packet), cipher.final()]);
}

function decrypt(packet) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', SECRET_KEY, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(packet), decipher.final()]);
}

function to5bit(v) {
  return Math.max(0, Math.min(255, Math.round(v))) >> 3;
}

function buildPowerPacket(on) {
  const packet = Buffer.from('055455524e0100000000000000000000', 'hex');
  packet[5] = on ? 1 : 0;
  return packet;
}

function buildColourPacket(r, g, b) {
  const packet = Buffer.from('0f53474c53000064501f00001f000032', 'hex');
  const r5 = to5bit(r);
  const g5 = to5bit(g);
  const b5 = to5bit(b);
  packet[9] = r5;
  packet[12] = r5;
  packet[10] = g5;
  packet[13] = g5;
  packet[11] = b5;
  packet[14] = b5;
  return packet;
}

function buildLampCountPacket(count) {
  const packet = Buffer.from('094c414d504e00320032000000000000', 'hex');
  const top = (count >> 8) & 0xFF;
  const bottom = count & 0xFF;
  packet[6] = top;
  packet[7] = bottom;
  packet[8] = top;
  packet[9] = bottom;
  return packet;
}

function buildVersionPackets() {
  return [
    Buffer.from('0356450000000000000000000000000000', 'hex'),
    Buffer.from('0356450100000000000000000000000000', 'hex'),
  ];
}

function decodeNotification(buf) {
  try {
    const clear = decrypt(buf);
    return clear;
  } catch (err) {
    return null;
  }
}

module.exports = {
  UUIDS,
  stripDashes,
  encrypt,
  decrypt,
  buildPowerPacket,
  buildColourPacket,
  buildLampCountPacket,
  buildVersionPackets,
  decodeNotification,
};
