'use strict';

const Homey = require('homey');
const protocol = require('../../lib/IdealLedProtocol');

const DISCOVER_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;
const WRITE_TIMEOUT_MS = 8000;
const COLOUR_DEBOUNCE_MS = 150;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const IDLE_DISCONNECT_MS = 60000;

class IdealLedDevice extends Homey.Device {

  async onInit() {
    this.log('ideal LED+ device initializing:', this.getName());

    this._lock = Promise.resolve();
    this._advertisement = null;
    this._peripheral = null;
    this._idleTimer = null;
    this._colourDebounceTimer = null;
    this._colourDebouncePromise = null;

    this.registerCapabilityListener('onoff', (value) => this._runLocked(() => this._setPower(value)));
    this.registerCapabilityListener('dim', () => this._debounceColour());
    this.registerCapabilityListener('light_hue', () => this._debounceColour());
    this.registerCapabilityListener('light_saturation', () => this._debounceColour());
    this.registerCapabilityListener('light_mode', () => Promise.resolve()); // ignore mode changes (we only support solid colour)
  }

  async onUninit() {
    this._clearIdleTimer();
    await this._disconnectPeripheral();
  }

  async onDeleted() {
    this._clearIdleTimer();
    await this._disconnectPeripheral();
  }

  _getAddress() {
    const store = this.getStore();
    return store.address || this.getData().id;
  }

  _runLocked(fn) {
    const run = this._lock
      .catch(() => {})
      .then(() => fn());
    this._lock = run.catch(() => {});
    return run;
  }

  _debounceColour() {
    if (this._colourDebounceTimer) {
      this.homey.clearTimeout(this._colourDebounceTimer);
      this._colourDebounceTimer = null;
    } else {
      this._colourDebouncePromise = new Promise((resolve, reject) => {
        this._colourDebounceResolve = resolve;
        this._colourDebounceReject = reject;
      });
    }

    const resolve = this._colourDebounceResolve;
    const reject = this._colourDebounceReject;

    this._colourDebounceTimer = this.homey.setTimeout(() => {
      this._colourDebounceTimer = null;
      this._colourDebouncePromise = null;
      this._runLocked(() => this._applyColourFromCapabilities()).then(resolve, reject);
    }, COLOUR_DEBOUNCE_MS);

    return this._colourDebouncePromise;
  }

  _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.homey.setTimeout(() => reject(new Error(`Timed out while ${label} (${ms}ms)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => this.homey.clearTimeout(timer));
  }

  async _scanForAdvertisement() {
    const address = this._getAddress();
    this.log('Scanning for BLE advertisement...');
    const advertisements = await this._withTimeout(
      this.homey.ble.discover([]),
      DISCOVER_TIMEOUT_MS,
      'scanning for advertisement',
    );
    const advertisement = advertisements.find((adv) => adv.address === address);
    if (!advertisement) {
      this.log(`Advertisement not found among ${advertisements.length} discovered device(s)`);
      throw new Error('Device not found during scan (out of range or powered off?)');
    }
    this.log('Found advertisement, rssi:', advertisement.rssi);
    this._advertisement = advertisement;
    return advertisement;
  }

  async _connect() {
    if (this._peripheral) {
      this.log('Reusing open connection');
      return this._peripheral;
    }

    if (this._advertisement) {
      try {
        this.log('Connecting using cached advertisement...');
        return await this._withTimeout(this._advertisement.connect(), CONNECT_TIMEOUT_MS, 'connecting');
      } catch (err) {
        this.log('Cached advertisement failed to connect, rescanning:', err.message);
        this._advertisement = null;
      }
    }

    const advertisement = await this._scanForAdvertisement();
    this.log('Connecting...');
    return this._withTimeout(advertisement.connect(), CONNECT_TIMEOUT_MS, 'connecting');
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      this.homey.clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _resetIdleTimer() {
    this._clearIdleTimer();
    this._idleTimer = this.homey.setTimeout(() => {
      this._idleTimer = null;
      this._runLocked(() => this._disconnectPeripheral()).catch(() => {});
    }, IDLE_DISCONNECT_MS);
  }

  async _disconnectPeripheral() {
    const peripheral = this._peripheral;
    this._peripheral = null;
    if (!peripheral) return;
    try {
      await peripheral.disconnect();
      this.log('Disconnected (idle)');
    } catch (err) {
      // ignore
    }
  }

  async _withConnection(packet) {
    const peripheral = await this._connect();
    this._peripheral = peripheral;
    this.log('Writing command...');

    try {
      await this._withTimeout(
        peripheral.write(protocol.UUIDS.SERVICE, protocol.UUIDS.WRITE_CMD, packet),
        WRITE_TIMEOUT_MS,
        'writing command',
      );
      this.log('Command written successfully');
      this._resetIdleTimer();
    } catch (err) {
      this._peripheral = null;
      this._advertisement = null;
      try {
        await peripheral.disconnect();
      } catch (disconnectErr) {
        // ignore
      }
      throw err;
    }
  }

  async _writeCommand(packet) {
    const encrypted = protocol.encrypt(packet);
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this._withConnection(encrypted);
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => this.homey.setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    throw lastErr;
  }

  async _setPower(on) {
    try {
      await this._writeCommand(protocol.buildPowerPacket(on));
    } catch (err) {
      this.error('Failed to set power:', err.message);
      throw err;
    }
  }

  async _applyColourFromCapabilities() {
    const hue = this.getCapabilityValue('light_hue') || 0;
    const saturation = this.getCapabilityValue('light_saturation');
    const dim = this.getCapabilityValue('dim');
    const sat = saturation == null ? 1 : saturation;
    const value = dim == null ? 1 : dim;

    const [r, g, b] = hsvToRgb(hue, sat, value);
    try {
      await this._writeCommand(protocol.buildColourPacket(r, g, b));
    } catch (err) {
      this.error('Failed to set colour:', err.message);
      throw err;
    }
  }

  async sendSolidColour(hue, saturation) {
    await this.setCapabilityValue('light_hue', hue).catch(() => {});
    await this.setCapabilityValue('light_saturation', saturation).catch(() => {});
    return this._runLocked(() => this._applyColourFromCapabilities());
  }

}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

module.exports = IdealLedDevice;