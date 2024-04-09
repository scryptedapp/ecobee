import axios, { AxiosRequestConfig } from 'axios'
import sdk, { Device, ScryptedDeviceBase, OnOff, DeviceProvider, ScryptedDeviceType, ThermostatMode, Thermometer, HumiditySensor, TemperatureSetting, Settings, Setting, ScryptedInterface, Refresh, TemperatureUnit, HumidityCommand, HumidityMode, HumiditySetting, VOCSensor, AirQualitySensor, AirQuality, CO2Sensor, TemperatureSettingStatus, HumiditySettingStatus, TemperatureCommand } from '@scrypted/sdk';
const { deviceManager } = sdk;

const API_RETRY = 2;

// Get degC from Ecobee integer temp
function ecobeeIntToCelsius(intV: string): number {
  // convert int F value to F
  let f = +intV/10
  // convert F to C
  let c = (5/9) * (f - 32);
  return +c.toFixed(2);
}

// Get Ecobee integer temp from degC
function celsiusToEcobeeInt(c: number): string {
  // convert C to F
  let f = (c * 1.8) + 32;
  return (f*10).toFixed(0);
}

function ecobeeToThermostatMode(mode: string): ThermostatMode {
  //  Values: auto, auxHeatOnly, cool, heat, off
  switch(mode) {
    case "cool":
      return ThermostatMode.Cool;
    case "heat":
      return ThermostatMode.Heat;
    case "auto":
      return ThermostatMode.HeatCool;
  }

  return ThermostatMode.Off;
}

function thermostatModeToEcobee(mode: ThermostatMode): string {
  //  Values: auto, auxHeatOnly, cool, heat, off
  switch(mode) {
    case ThermostatMode.Cool:
      return "cool";
    case ThermostatMode.Heat:
      return "heat";
    case ThermostatMode.HeatCool:
      return "auto";
  }

  return "off"
}

function humModeFromEcobee(mode: string): HumidityMode {
  // Values: auto, manual, off
  switch(mode) {
    case 'auto':
      return HumidityMode.Auto;
    case "manual":
      return HumidityMode.Humidify;
  }

  return HumidityMode.Off
}

class EcobeeThermostat extends ScryptedDeviceBase implements HumiditySensor, Thermometer, TemperatureSetting, Refresh, OnOff, HumiditySetting, VOCSensor, AirQualitySensor, CO2Sensor {
  revisionList: string[];
  provider: EcobeeController;

  constructor(nativeId: string, provider: EcobeeController) {
    super(nativeId);
    this.provider = provider;

    this.temperatureUnit = TemperatureUnit.F
    const modes: ThermostatMode[] = [ThermostatMode.Cool, ThermostatMode.Heat, ThermostatMode.HeatCool, ThermostatMode.Off];
    this.temperatureSetting = {
      availableModes: modes,
    } as TemperatureSettingStatus;

    let humModes: HumidityMode[] = [HumidityMode.Auto, HumidityMode.Humidify, HumidityMode.Off];
    this.humiditySetting = {
      mode: HumidityMode.Off,
      availableModes: humModes,
    } as HumiditySettingStatus;

    setImmediate(() => this.refresh("constructor", false));
  }

  /*
   * Get the recommended refresh/poll frequency in seconds for this device.
   */
   async getRefreshFrequency(): Promise<number> {
      return 15;
   }

   /* refresh(): Request from Scrypted to refresh data from device 
    *            Poll from API '/thermostatSummary' endpoint for timestamp of last changes and compare to last check
    *            Updates equipmentStatus on each call
    */
   async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
    this.console.log(`${refreshInterface} requested refresh: ${new Date()}`);

    const json = {
      selection: {
        selectionType: "thermostats",
        selectionMatch: this.nativeId,
        includeEquipmentStatus: true,
      }
    }
    const data = await this.provider.req('get', 'thermostatSummary', json)

    // Update equipmentStatus, trigger reload if changes detected
    this._updateEquipmentStatus(data.statusList[0].split(":")[1]);
    if (this._updateRevisionList(data.revisionList[0]))
      await this.reload()
   }

  /*
   * Set characteristics based on equipmentStatus from API
   * 
   *  Possible eqipmentStatus values:
   *    heatPump, heatPump[2-3], compCool[1-2], auxHeat[1-3],
   *    fan, humidifier, dehumidifier, ventilator, economizer,
   *    compHotWater, auxHotWater
   */
   _updateEquipmentStatus(equipmentStatus: string): void {
    equipmentStatus = equipmentStatus.toLowerCase()
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Equipment status:`, equipmentStatus || 'not running');
    let nextTemperatureSetting = this.temperatureSetting as TemperatureSettingStatus;
    if (equipmentStatus.includes("heat"))
      // values: heatPump, heatPump[2-3], auxHeat[1-3]
      nextTemperatureSetting.activeMode = ThermostatMode.Heat;
    else if (equipmentStatus.includes("cool"))
      // values: compCool[1-2]
      nextTemperatureSetting.activeMode =  ThermostatMode.Cool;
    else
      nextTemperatureSetting.activeMode = ThermostatMode.Off;

    // fan status
    if (equipmentStatus.includes('fan')) {
      this.on = true;
    } else {
      this.on = false;
    }

    // humidifier status
    let nextHumiditySetting = this.humiditySetting as HumiditySettingStatus;
    if (equipmentStatus.includes('humidifier')) {
      nextHumiditySetting.activeMode = HumidityMode.Humidify;
    } else {
      nextHumiditySetting.activeMode = HumidityMode.Off;
    }

    this.humiditySetting = nextHumiditySetting;
    this.temperatureSetting = nextTemperatureSetting;
  }

  /* revisionListChanged(): Compare a new revision list to the stored list, return true if changed
   *  
   */
  _updateRevisionList(listStr: string): boolean {
    const listItems = ["tId", "tName", "connected", "thermostat", "alerts", "runtime", "interval"];
    const oldList = this.revisionList;
    this.revisionList = listStr.split(':');
    
    if (!oldList)
      return true;

    // Compare each element, skip first 3
    for (let i = 3; i < listItems.length; i++) {
      if (this.revisionList[i] !== oldList[i]) {
        this.console.log(`[${this.name}] (${new Date().toLocaleString()}) ${listItems[i]} changes detected.`)
        return true;
      }
    }
    return false;
  }

  /* reload(): Reload all thermostat data from API '/thermostat' endpoint
   *
   */
  async reload(): Promise<void> {
    const json = {
      selection: {
        selectionType: "thermostats",
        selectionMatch: this.nativeId,
        includeSettings: true,
        includeRuntime: true,
        includeEquipmentStatus: true,
      }
    }
    const data = (await this.provider.req('get', 'thermostat', json)).thermostatList[0];
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Reload data`, data)

    // Set runtime values
    this.temperature = ecobeeIntToCelsius(data.runtime.actualTemperature);
    this.humidity = Number(data.runtime.actualHumidity);

    // Set current equipment status values
    this._updateEquipmentStatus(data.equipmentStatus);

    // update based on mode
    let nextTemperatureSetting = this.temperatureSetting as TemperatureSettingStatus;
    nextTemperatureSetting.mode = ecobeeToThermostatMode(data.settings.hvacMode);

    switch(data.settings.hvacMode) {
      case 'cool':
        nextTemperatureSetting.setpoint = ecobeeIntToCelsius(data.runtime.desiredCool);
        break;
      case 'heat':
        nextTemperatureSetting.setpoint = ecobeeIntToCelsius(data.runtime.desiredHeat);
        break;
      default:
        nextTemperatureSetting.setpoint = [
          ecobeeIntToCelsius(data.runtime.desiredHeat),
          ecobeeIntToCelsius(data.runtime.desiredCool),
        ]
    }

    // update humidifier based on mode
    let nextHumiditySetting = this.humiditySetting as HumiditySettingStatus;
    nextHumiditySetting.mode = humModeFromEcobee(data.settings.humidifierMode);
    nextHumiditySetting.humidifierSetpoint = Number(data.settings.humidity);

    // Update Air Quality sensor
    if (this.interfaces.includes(ScryptedInterface.AirQualitySensor))
      this.setAirQualityFromAQScore(data.runtime.actualAQScore);
    if (this.interfaces.includes(ScryptedInterface.VOCSensor))
      this.vocDensity = Number(data.runtime.actualVOC)/10;
    if (this.interfaces.includes(ScryptedInterface.CO2Sensor))
      this.co2ppm = Number(data.runtime.actualCO2)/10;


    this.temperatureSetting = nextTemperatureSetting;
    this.humiditySetting = nextHumiditySetting;
  }

  async setHumidity(humidity: HumidityCommand): Promise<void> {
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) setHumidity ${humidity.mode} ${humidity.humidifierSetpoint}: not yet supported`);
  }

  async setTemperatureUnit(temperatureUnit: TemperatureUnit): Promise<void> {
    this.temperatureUnit = temperatureUnit;
  }
  
  async setTemperature(command: TemperatureCommand): Promise<void> {
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) setTemperature ${command}`)
    this.console.log(command);
    // create api payload
    const data = {
      selection: {
        selectionType:"registered",
        selectionMatch: this.nativeId,
      },
    }

    // setting setpoint
    if (Array.isArray(command.setpoint)) {
      data['functions'] = [
        {
          type:"setHold",
          params:{
            holdType: "nextTransition",
            heatHoldTemp: celsiusToEcobeeInt(command.setpoint[0]),
            coolHoldTemp: celsiusToEcobeeInt(command.setpoint[1]),
          }
        }
      ]
    } else if (command.setpoint !== undefined) {
      data['functions'] = [
        {
          type:"setHold",
          params:{
            holdType: "nextTransition",
            heatHoldTemp: celsiusToEcobeeInt(command.setpoint),
            coolHoldTemp: celsiusToEcobeeInt(command.setpoint),
          }
        }
      ]
    }

    // setting mode
    if (command.mode) {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) setTemperature.mode ${command.mode}`)

      data['thermostat'] = {
        settings:{
          hvacMode: thermostatModeToEcobee(command.mode)
        }
      }
    }

    // api transaction
    const resp = await this.provider.req('post', 'thermostat', undefined, data);
    if (resp.status.code == 0) {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) setTemperature success`)
      await this.reload();
      return;
    }

    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) setTemperature failed: ${resp}`)

  }

  async turnOff(): Promise<void> {
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) fanOff: setting fan to auto`)

    const data = {
      selection: {
        selectionType: "registered",
        selectionMatch: this.nativeId,
      },
      functions: [
        {
          type: "setHold",
          params: {
            coolHoldTemp: 900,
            heatHoldTemp: 550,
            holdType: "nextTransition",
            fan: "auto",
            isTemperatureAbsolute: "false",
            isTemperatureRelative: "false",
          }
        }
      ]
    }

    const resp = await this.provider.req('post', 'thermostat', undefined, data);
    if (resp.status.code == 0) {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) fanOff success`)
      await this.reload();
      return;
    }

    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) fanOff failed: ${resp}`)
  }

  async turnOn(): Promise<void> {
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) fanOn: setting fan to on`)

    const data = {
      selection: {
        selectionType: "registered",
        selectionMatch: this.nativeId,
      },
      functions: [
        {
          type:"setHold",
          params: {
            coolHoldTemp: 900,
            heatHoldTemp: 550,
            holdType: "nextTransition",
            fan: "on",
            isTemperatureAbsolute: "false",
            isTemperatureRelative: "false",
          }
        }
      ]
    }

    const resp = await this.provider.req('post', 'thermostat', undefined, data);
    if (resp.status.code == 0) {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) fanOn success`)
      await this.reload();
      return;
    }

    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) fanOn failed: ${resp}`)
  }

  setAirQualityFromAQScore(aqScore: number) {
    // ecobee seems to use a 0-500 score
    // 0-50: Good, 51-100: Moderate, 101-150: Unhealthy sensitive groups, 151-200: Unhealthy, 201-300: Very Unhealthy, 301-500: Hazardous
    // Combine Unhealthy and Very Unhealthy into "Poor"
    if (aqScore < 51 ) this.airQuality = AirQuality.Excellent;
    else if (aqScore < 101 ) this.airQuality = AirQuality.Good;
    else if (aqScore < 151) this.airQuality = AirQuality.Fair;
    else if (aqScore < 201 ) this.airQuality = AirQuality.Poor;
    else if (aqScore < 301) this.airQuality = AirQuality.Poor;
    else if (aqScore < 501) this.airQuality = AirQuality.Inferior;
    else this.airQuality = AirQuality.Unknown;
  }
}

class EcobeeController extends ScryptedDeviceBase implements DeviceProvider, Settings {
  devices = new Map<string, any>();
  access_token: string;

  constructor() {
    super()
    this.log.clearAlerts();
    if (!this.storage.getItem("api_base"))
      this.storage.setItem("api_base", "api.ecobee.com");

    this.initialize();
  }

  async initialize(): Promise<void> {
    // If no clientId, request clientId to start authentication process
    if (!this.storage.getItem("client_id")) {
      this.log.a("You must specify a client ID.")
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Enter a client ID for this app from the Ecobee developer portal. Then, collect the PIN and enter in Ecobee 'My Apps'. Restart this app to complete.`)
      return;
    }

    if (!this.storage.getItem("refresh_token"))
      // If no refresh_token, try to get token
      await this.getToken();
    else if (!this.access_token)
      await this.refreshToken();

    this.discoverDevices();
  }

  async releaseDevice(id: string, nativeId: string): Promise<void> {
    
  }

  async getSettings(): Promise<Setting[]> {
    return [
      {
        title: "Sensors Only",
        key: "sensors_only",
        type: "boolean",
        description: "Expose only sensors, and not thermostat",
        value: this.storage.getItem("sensors_only") === "true",
      },
      {
        title: "API Base URL",
        key: "api_base",
        description: "Customize the API base URL",
        value: this.storage.getItem("api_base"),
      },
      {
        title: "API Client ID",
        key: "client_id",
        description: "Your Client ID from the Ecboee developer portal",
        value: this.storage.getItem("client_id"),
      }
    ]
  }

  async putSetting(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value.toString());

    // Try to get a code when a client ID is saved
    if (key === "client_id") {
      await this.getCode();
    }
  }

  // Get a code from Ecobee API for user verification
  async getCode() {
    // GET https://api.ecobee.com/authorize?response_type=ecobeePin&client_id=APP_KEY&scope=SCOPE
    const authUrl = `https://${this.storage.getItem("api_base")}/authorize`
    const authParams = {
      response_type:'ecobeePin',
      scope: "smartWrite",
      client_id: this.storage.getItem("client_id"),
    }
    let authData = (await axios.get(authUrl, {
      params: authParams,
    })).data
    
    this.log.clearAlerts();
    this.log.a(`[${this.name}] (${new Date().toLocaleString()}) Got code ${authData.ecobeePin}. Enter this in 'My Apps' Ecobee portal. Then restart this app.`)
    this.storage.setItem("ecobee_code", authData.code);
  }

  // Trade the validated code for an access token
  async getToken() {
    // POST https://api.ecobee.com/token?grant_type=ecobeePin&code=AUTHORIZATION_TOKEN&client_id=APP_KEY&ecobee_type=jwt
    const tokenUrl = `https://${this.storage.getItem("api_base")}/token`
    const tokenParams = {
      grant_type:'ecobeePin',
      code: this.storage.getItem("ecobee_code"),
      client_id: this.storage.getItem("client_id"),
      ecobee_type: "jwt",
    };
    let tokenData = (await axios.post(tokenUrl, null, {
      params: tokenParams
    })).data;
    this.access_token = tokenData.access_token;
    this.storage.setItem("refresh_token", tokenData.refresh_token);
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Got tokens`)
  }

  // Refresh the tokens
  async refreshToken() {
    // POST https://api.ecobee.com/token?grant_type=refresh_token&refresh_token=REFRESH_TOKEN&client_id=APP_KEY&ecobee_type=jwt
    const tokenUrl = `https://${this.storage.getItem("api_base")}/token`
    const tokenParams = {
      grant_type:'refresh_token',
      refresh_token: this.storage.getItem("refresh_token"),
      client_id: this.storage.getItem("client_id"),
      ecobee_type: "jwt",
    };
    let tokenData = (await axios.post(tokenUrl, null, {
      params: tokenParams
    })).data;
    this.access_token = tokenData.access_token;
    this.storage.setItem("refresh_token", tokenData.refresh_token);
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Refreshed tokens`)
  }

  // Generic API request
  async req(
    method: string,
    endpoint: string,
    json?: any,
    data?: any,
    attempt?: number,
  ): Promise<any> {
    if (attempt > API_RETRY) {
      throw new Error(` request to ${method}:${endpoint} failed after ${attempt} retries`);
    }

    // Configure API request
    const config: AxiosRequestConfig = {
      method,
      baseURL: `https://${this.storage.getItem("api_base")}/1/`,
      url: endpoint,
      headers: {
        Authorization: `Bearer ${this.access_token}`,
      },
      data,
      timeout: 10000,
    }
    if (json)
      config.params = { json };

    // Make API request, recursively retry after token refresh
    try {
      return (await axios.request(config)).data;
    } catch (e) {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) req failed ${e}`)
      // refresh token and retry request
      await this.refreshToken();
      return await this.req(method, endpoint, json, data, attempt++);
    }
  }

  async discoverDevices(): Promise<void> {
    // Get a list of all accessible devices
    const json = {
      selection: {
        selectionType: "registered",
        selectionMatch: "",
        includeSettings: true,
        includeRuntime: true,
      }
    }
    const apiDevices = (await this.req('get', 'thermostat', json)).thermostatList;
    this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Discovered ${apiDevices.length} devices.`);

    // Create a list of devices found from the API
    const devices: Device[] = [];
    for (let apiDevice of apiDevices) {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Discovered ${apiDevice.brand} ${apiDevice.modelNumber} ${apiDevice.name} (${apiDevice.identifier})`);

      let deviceType: ScryptedDeviceType = ScryptedDeviceType.Thermostat;
      const interfaces: ScryptedInterface[] = [
        ScryptedInterface.Thermometer,
        ScryptedInterface.HumiditySensor,
        ScryptedInterface.Refresh,
      ]

      // Support exposing only sensors, not Thermostat
      if (this.storage.getItem("sensors_only") === "true") {
        this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Devices will be exposed as sensors only.`)
        deviceType = ScryptedDeviceType.Sensor;
      } else {
        interfaces.push(
          ScryptedInterface.TemperatureSetting,
          ScryptedInterface.OnOff,
        )

        if (apiDevice.settings.hasHumidifier)
          interfaces.push(ScryptedInterface.HumiditySetting);
      }

      // Add AQ devices if data available
      if (apiDevice.runtime.actualAQScore >= 0)
        interfaces.push(ScryptedInterface.AirQualitySensor);
      if (apiDevice.runtime.actualVOC >= 0)
        interfaces.push(ScryptedInterface.VOCSensor);
      if (apiDevice.runtime.actualCO2 >= 0)
        interfaces.push(ScryptedInterface.CO2Sensor);

      const device: Device = {
        nativeId: apiDevice.identifier,
        name: `${apiDevice.name} thermostat`,
        type: deviceType,
        info: {
          model: apiDevice.brand,
          manufacturer: apiDevice.modelNumber,
          serialNumber: apiDevice.identifier,
        },
        interfaces,
      }
      devices.push(device);
    }

    // Sync full device list
    await deviceManager.onDevicesChanged({
        devices,
    });

    for (let device of devices) {
      let providerDevice = this.devices.get(device.nativeId);
      if (!providerDevice) {
        providerDevice = new EcobeeThermostat(device.nativeId, this)
        this.devices.set(device.nativeId, providerDevice)
      }
    }
  }

  getDevice(nativeId: string) {
    return this.devices.get(nativeId);
  }

}

export default new EcobeeController();
