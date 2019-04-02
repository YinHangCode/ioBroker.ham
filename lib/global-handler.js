/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

const inherits = require('util').inherits;

let User;
let hap;
//let version;
let Server;
let Plugin;
//let log;
let Characteristic;
let once;

let server;
const charMap = {};

let logger;
let updateState;
let updateDev;
let updateChannel;
let setState;
let mapper;
let ignoreInfoAccessoryServices;
let insecureAccess;
let characteristicPollingInterval;
const characteristicPollingTimeouts = {};
const characteristicValues = {};

function customStringify(v, func, intent) {
    const cache = new Map();
    return JSON.stringify(v, function (key, value) {
        if (typeof value === 'object' && value !== null) {
            if (cache.get(value)) {
                // Circular reference found, discard key
                return;
            }
            // Store value in our map
            cache.set(value, true);
        }
        return value;
    }, intent);
}

function init(config) {
    logger = config.logger;
    updateState = config.updateState;
    updateDev = config.updateDev;
    updateChannel = config.updateChannel;
    setState = config.setState;
    ignoreInfoAccessoryServices = config.ignoreInfoAccessoryServices;
    insecureAccess = config.insecureAccess;
    characteristicPollingInterval = config.characteristicPollingInterval;

    mapper = require('./mapper')(config);

    User = require(config.homebridgeBasePath + 'lib/user').User;
    User.setStoragePath(config.homebridgeConfigPath);
    hap = require(config.homebridgeBasePath + 'node_modules/hap-nodejs');
    //version = require(config.homebridgeBasePath + 'lib/version');
    Server = require(config.homebridgeBasePath + 'lib/server').Server;
    Plugin = require(config.homebridgeBasePath + 'lib/plugin').Plugin;
    if(null != config.homebridgePluginPath) {
        Plugin.addPluginPath(config.homebridgePluginPath);
    }
    //log = require(config.homebridgeBasePath + 'lib/logger')._system;
    once = require(config.homebridgeBasePath + 'node_modules/hap-nodejs/lib/util/once').once;
    Characteristic = hap.Characteristic;

    inherits(MyBridge, hap.Bridge);

    override(MyBridge, function publish(info, allowInsecureRequest) {
        logger.debug('iobroker.ham Bridge publish ' + customStringify(info));
        // Вызов метода родительского класса
        // Calling the method of the parent class
        publish.inherited.call(this, info, allowInsecureRequest);
    });

    /*
    // Переопределение метода в дочернем классе
    // Overriding a method in a child class
    override(MyBridge, function addService(service) {
        // Собственный функционал
        // Own Functionality
        logger.info('iobroker.ham Bridge addService '+JSON.stringify(service)); //OK, undefined
        // Вызов метода родительского класса
        // Calling the method of the parent class
        return addService.inherited.call(this, service);
    });
    */

    function handleCharacteristicPolling(accessory, service, characteristic) {
        if (characteristicPollingInterval) {
            if (characteristicPollingTimeouts[accessory.UUID + '.' + service.UUID + '.' + characteristic.UUID]) {
                clearTimeout(characteristicPollingTimeouts[accessory.UUID + '.' + service.UUID + '.' + characteristic.UUID]);
            }
            characteristicPollingTimeouts[accessory.UUID + '.' + service.UUID + '.' + characteristic.UUID] = setTimeout(function() {
                characteristic.getValue(function(err, value) {
                    if (value !== characteristicValues[accessory.UUID + '.' + service.UUID + '.' + characteristic.UUID]) {
                        logger.debug('Char value update from polling: ' + characteristicValues[accessory.UUID + '.' + service.UUID + '.' + characteristic.UUID] + ' --> ' + value);
                        handleCharValue(accessory, service, characteristic, value);
                    }
                    handleCharacteristicPolling(accessory, service, characteristic);
                });
            }, characteristicPollingInterval);
        }
    }

    function iterateCharArray(chars, accessory, service, dev_idname, sr_id, sr_idname) {
        for (const channelIndex in chars) {
            if (!chars.hasOwnProperty(channelIndex)) continue;

            const char      = chars[channelIndex];
            const ch_id     = char.UUID;
            const ch_name   = char.displayName;
            const ch_val    = char.value;
            const ch_idname = mapper.mapCharacteristicType(sr_id, ch_id, ch_name);
            const id        = dev_idname + '.' + sr_idname + '.' + ch_idname;

            const common = mapper.mapCharacteristicProperties(char);
            logger.debug('Mapped Common for ' + id + ': ' + JSON.stringify(common));
            if (common.write) {
                charMap[id] = char; // TODO only if write allowed!
                logger.silly('Add object to charmap with id ' + id + '/' + customStringify(char));
            }

            char.on('change', data => {
                logger.debug('Char change event: ' + data.oldValue + ' --> ' + data.newValue);
                handleCharValue(accessory, service, char, data.newValue);
            });

            updateState(dev_idname, sr_idname, ch_idname, ch_name, ch_val, common, ch_id, () => {
                char.getValue((err, value) => {
                    if (err) {
                        logger.warn('Error while getting current value: ' + err);
                        return;
                    }
                    handleCharValue(accessory, service, char, value);
                })
            });
            handleCharacteristicPolling(accessory, service, char);
        }
    }

    override(MyBridge, function addBridgedAccessory(accessory, deferUpdate) {
        // Вызов метода родительского класса
        // Calling the method of the parent class
        accessory = addBridgedAccessory.inherited.call(this, accessory, deferUpdate);
        logger.debug('iobroker.ham Bridge addBridgedAccessory ' + customStringify(accessory)); //OK
        // Новое устройство
        // New device
        const dev_id     = accessory.UUID;
        const dev_idname = mapper.mapAccessoryUUID(dev_id, accessory.displayName);
        const dev_name   = accessory.displayName;
        const dev_cat    = accessory.category;

        updateDev(dev_idname, dev_name, dev_cat, dev_id);

        for (const index in accessory.services) {
            if (!accessory.services.hasOwnProperty(index)) continue;

            const service   = accessory.services[index];
            const sr_id     = service.UUID;
            const sr_idname = mapper.mapServiceType(sr_id, service.displayName);
            const sr_name   = service.displayName;

            if (ignoreInfoAccessoryServices && sr_idname === 'Accessory-Information') {
                continue;
            }

            logger.silly('Add service class=' + customStringify(service));
            updateChannel(dev_idname, sr_idname, sr_name, sr_id);

            iterateCharArray(service.characteristics, accessory, service, dev_idname, sr_id, sr_idname);
            if (service.optionalCharacteristics) {
                iterateCharArray(service.optionalCharacteristics, accessory, service, dev_idname, sr_id, sr_idname);
            }

        }
        return accessory;
    });

    Server.prototype._createBridge = function() {
        logger.debug('iobroker.ham Bridge create'); //OK
        // pull out our custom Bridge settings from config.json, if any
        const bridgeConfig = this._config.bridge || {};

        // Create our Bridge which will host all loaded Accessories
        return new MyBridge(bridgeConfig.name || 'Homebridge', hap.uuid.generate('HomeBridge'));
    };

    // Updated to compare value differetly. Needed till officially updated
    Characteristic.prototype.setValue = function(newValue, callback, context, connectionID) {

      if ( newValue instanceof Error ) {
        this.status = newValue
      } else {
        this.status = null;
      }

      newValue = this.validateValue(newValue); //validateValue returns a value that has be cooerced into a valid value.

      var oldValue = this.value;

      if (this.listeners('set').length > 0) {

        // allow a listener to handle the setting of this value, and wait for completion
        this.emit('set', newValue, once(function(err) {
          this.status = err;
          if (err) {
            // pass the error along to our callback
            if (callback) callback(err);
          }
          else {
            if (newValue === undefined || newValue === null)
              newValue = this.getDefaultValue();
            // setting the value was a success; so we can cache it now
            this.value = newValue;
            if (callback) callback();

            if (this.eventOnlyCharacteristic === true || oldValue !== newValue)
              this.emit('change', { oldValue:oldValue, newValue:newValue, context:context });
          }

        }.bind(this)), context, connectionID);

      }
      else {
        if (newValue === undefined || newValue === null)
          newValue = this.getDefaultValue();
        // no one is listening to the 'set' event, so just assign the value blindly
        this.value = newValue;
        if (callback) callback();

        if (this.eventOnlyCharacteristic === true || oldValue !== newValue)
          this.emit('change', { oldValue:oldValue, newValue:newValue, context:context });
      }

      return this; // for chaining
    }

    function MyBridge(displayName, serialNumber) {
        logger.debug('iobroker.ham Bridge constructor');
        MyBridge.super_.call(this, displayName, serialNumber);
    }
}

function registerExistingAccessory(UUID, name) {
    mapper.mapAccessoryUUID(UUID, name);
}

function start() {
    const insecureAccess = false;
    logger.info('Using Homebridge Config Path: ' + User.persistPath());
    // Initialize HAP-NodeJS with a custom persist directory
    hap.init(User.persistPath());

    server = new Server(insecureAccess);

    server.run();
}

function end() {
    if (server) {
        server._teardown();
        // Save cached accessories to persist storage.
        server._updateCachedAccessories();
    }
}

function setValueForCharId(id, value) {
    if (charMap[id]) {
        logger.debug('set value of char for ' + id);
        charMap[id].setValue(value);
    }
}

function handleCharValue(accessory, serv, char, newValue){
    logger.debug('handleCharValue = ' + newValue);
    logger.silly('characteristic = ' + customStringify(char));
    logger.silly('accessory =' + customStringify(accessory));

    const sr_id      = serv.UUID;
    const sr_idname  = mapper.mapServiceType(sr_id, serv.displayName);
    const ch_id      = char.UUID;
    const ch_idname  = mapper.mapCharacteristicType(sr_id, ch_id, char.displayName);
    const dev_id     = accessory.UUID;
    const dev_idname = mapper.mapAccessoryUUID(dev_id, accessory.displayName);
    const value      = newValue;

    setState(dev_idname, sr_idname, ch_idname, value);
    characteristicValues[accessory.UUID + '.' + serv.UUID + '.' + char.UUID] = newValue;
}

// Средство для переопределения функций
// Tools for overriding functions
function override(child, fn) {
    child.prototype[fn.name] = fn;
    fn.inherited = child.super_.prototype[fn.name];
}

exports.init = init;
exports.end = end;
exports.setValueForCharId = setValueForCharId;
exports.start = start;
exports.registerExistingAccessory = registerExistingAccessory;
