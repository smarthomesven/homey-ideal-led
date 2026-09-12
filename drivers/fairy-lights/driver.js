'use strict';

const Homey = require('homey');
const { UUIDS } = require('../../lib/IdealLedProtocol');

const PAIR_DISCOVERY_TIMEOUT_MS = 10000;

class IdealLedDriver extends Homey.Driver {

  async onInit() {
    this.log('iDeal LED+ driver initialized');
  }

  matchesDevice(advertisement) {
    const name = (advertisement.localName || '').toLowerCase();
    if (name.startsWith('isp-') || name.startsWith('idl-')) return true;
    const services = advertisement.serviceUuids || [];
    return services.some((uuid) => uuid.replace(/-/g, '').toLowerCase() === UUIDS.SERVICE.replace(/-/g, ''));
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover([], PAIR_DISCOVERY_TIMEOUT_MS);
    const found = advertisements.filter((adv) => this.matchesDevice(adv));

    this.log(`Pairing: found ${found.length} matching device(s) out of ${advertisements.length} advertisement(s)`);

    return found.map((adv) => ({
      name: adv.localName || 'iDeal LED+',
      data: {
        id: adv.address,
      },
      store: {
        address: adv.address,
      },
    }));
  }

}

module.exports = IdealLedDriver;