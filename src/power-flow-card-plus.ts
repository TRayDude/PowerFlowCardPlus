/* eslint-disable wc/guard-super-call */
/* eslint-disable import/extensions */
/* eslint-disable no-nested-ternary */
import { UnsubscribeFunc } from "home-assistant-js-websocket";
import { HomeAssistant, LovelaceCardEditor } from "custom-card-helpers";
import { html, LitElement, PropertyValues, svg, TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { PowerFlowCardPlusConfig } from "./power-flow-card-plus-config";
import { coerceNumber, isNumberValue } from "./utils/utils";
import { registerCustomCard } from "./utils/register-custom-card";
import { RenderTemplateResult, subscribeRenderTemplate } from "./template/ha-websocket.js";
import { styles } from "./style";
import { defaultValues, getDefaultConfig } from "./utils/get-default-config";
import localize from "./localize/localize";
import { getEntityStateWatts } from "./states/utils/getEntityStateWatts";
import { getEntityState } from "./states/utils/getEntityState";
import { doesEntityExist } from "./states/utils/existenceEntity";
import { computeFlowRate } from "./utils/computeFlowRate";
import { getGridConsumptionState, getGridProductionState, getGridSecondaryState } from "./states/raw/grid";
import { getSolarSecondaryState } from "./states/raw/solar";
import { getSolarState } from "./states/raw/solar";
import { getBatteryInState, getBatteryOutState, getBatteryStateOfCharge } from "./states/raw/battery";
import { computeFieldIcon, computeFieldName } from "./utils/computeFieldAttributes";
import { convertColorListToHex } from "./utils/convertColor";
import { adjustZeroTolerance } from "./states/tolerance/base";
import { getIndividualState } from "./states/raw/individual";
import { getSecondaryState } from "./states/raw/base";
import { getNonFossilHas, getNonFossilHasPercentage, getNonFossilSecondaryState } from "./states/raw/nonFossil";
import { getHomeSecondaryState } from "./states/raw/home";
import { generalSecondarySpan } from "./components/spans/generalSecondarySpan";
import { HomeSources, NewDur, TemplatesObj } from "./type";
import { individualSecondarySpan } from "./components/spans/individualSecondarySpan";
import { displayValue } from "./utils/displayValue";
import { allDynamicStyles } from "./style/all";
import { displayNonFossilState } from "./utils/displayNonFossilState";
import { nonFossilElement } from "./components/nonFossil";
import { solarElement } from "./components/solar";
import { gridElement } from "./components/grid";
import { homeElement } from "./components/home";
import { individual2Element } from "./components/individual2";
import { batteryElement } from "./components/battery";
import { flowElement } from "./components/flows";
import { styleLine } from "./utils/styleLine";
import { dashboardLinkElement } from "./components/misc/dashboard_link";

const circleCircumference = 238.76104;

registerCustomCard({
  type: "power-flow-card-plus",
  name: "Power Flow Card Plus",
  description:
    "An extended version of the power flow card with richer options, advanced features and a few small UI enhancements. Inspired by the Energy Dashboard.",
});

@customElement("power-flow-card-plus")
export class PowerFlowCardPlus extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config = {} as PowerFlowCardPlusConfig;

  @state() private _templateResults: Partial<Record<string, RenderTemplateResult>> = {};
  @state() private _unsubRenderTemplate?: Promise<UnsubscribeFunc>;
  @state() private _unsubRenderTemplates?: Map<string, Promise<UnsubscribeFunc>> = new Map();
  @state() private _width = 0;

  @query("#battery-grid-flow") batteryGridFlow?: SVGSVGElement;
  @query("#battery-home-flow") batteryToHomeFlow?: SVGSVGElement;
  @query("#grid-home-flow") gridToHomeFlow?: SVGSVGElement;
  @query("#solar-battery-flow") solarToBatteryFlow?: SVGSVGElement;
  @query("#solar-grid-flow") solarToGridFlow?: SVGSVGElement;
  @query("#solar-home-flow") solarToHomeFlow?: SVGSVGElement;

  setConfig(config: PowerFlowCardPlusConfig): void {
    if (!config.entities || (!config.entities?.battery?.entity && !config.entities?.grid?.entity && !config.entities?.solar?.entity)) {
      throw new Error("At least one entity for battery, grid or solar must be defined");
    }
    this._config = {
      ...config,
      kw_decimals: coerceNumber(config.kw_decimals, defaultValues.kilowattDecimals),
      min_flow_rate: coerceNumber(config.min_flow_rate, defaultValues.minFlowRate),
      max_flow_rate: coerceNumber(config.max_flow_rate, defaultValues.maxFlowRate),
      w_decimals: coerceNumber(config.w_decimals, defaultValues.wattDecimals),
      watt_threshold: coerceNumber(config.watt_threshold, defaultValues.wattThreshold),
      max_expected_power: coerceNumber(config.max_expected_power, defaultValues.maxExpectedPower),
      min_expected_power: coerceNumber(config.min_expected_power, defaultValues.minExpectedPower),
      display_zero_lines: {
        mode: config.display_zero_lines?.mode ?? defaultValues.displayZeroLines.mode,
        transparency: coerceNumber(config.display_zero_lines?.transparency, defaultValues.displayZeroLines.transparency),
        grey_color: config.display_zero_lines?.grey_color ?? defaultValues.displayZeroLines.grey_color,
      },
    };
  }

  public connectedCallback() {
    super.connectedCallback();
    this._tryConnectAll();
  }

  public disconnectedCallback() {
    this._tryDisconnectAll();
  }

  // do not use ui editor for now, as it is not working
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import("./ui-editor/ui-editor");
    return document.createElement("power-flow-card-plus-editor");
  }

  public static getStubConfig(hass: HomeAssistant): object {
    // get available power entities
    return getDefaultConfig(hass);
  }

  public getCardSize(): Promise<number> | number {
    return 3;
  }

  private previousDur: { [name: string]: number } = {};

  public additionalCircleRate = (entry?: boolean | number, value?: number) => {
    if (entry === true && value) {
      return value;
    }
    if (isNumberValue(entry)) {
      return entry;
    }
    return 1.66;
  };

  public openDetails(event: { stopPropagation: any; key?: string }, entityId?: string | undefined): void {
    event.stopPropagation();
    if (!entityId || !this._config.clickable_entities) return;
    /* also needs to open details if entity is unavailable, but not if entity doesn't exist is hass states */
    if (!doesEntityExist(this.hass, entityId)) return;
    const e = new CustomEvent("hass-more-info", {
      composed: true,
      detail: { entityId },
    });
    this.dispatchEvent(e);
  }

  /**
   * Determine wether to show the line or not based on if the power is flowing or not and if not, based on display_zero_lines mode
   * @param power - power flowing through the line
   * @returns  boolean - `true` if line should be shown, `false` if not
   */
  public showLine(power: number): boolean {
    if (power > 0) return true;
    return this._config?.display_zero_lines?.mode !== "hide";
  }

  protected render(): TemplateResult {
    if (!this._config || !this.hass) {
      return html``;
    }

    const { entities } = this._config;

    this.style.setProperty("--clickable-cursor", this._config.clickable_entities ? "pointer" : "default");

    const initialNumericState = null as null | number;
    const initialSecondaryState = null as null | string | number;

    const grid = {
      entity: entities.grid?.entity,
      has: entities?.grid?.entity !== undefined,
      hasReturnToGrid: typeof entities.grid?.entity === "string" || entities.grid?.entity?.production,
      state: {
        fromGrid: getGridConsumptionState(this.hass, this._config),
        toGrid: getGridProductionState(this.hass, this._config),
        toBattery: initialNumericState,
        toHome: initialNumericState,
      },
      powerOutage: {
        has: entities.grid?.power_outage?.entity !== undefined,
        isOutage:
          (entities.grid && this.hass.states[entities.grid.power_outage?.entity]?.state) === (entities.grid?.power_outage?.state_alert ?? "on"),
        icon: entities.grid?.power_outage?.icon_alert || "mdi:transmission-tower-off",
        name: entities.grid?.power_outage?.label_alert ?? html`Power<br />Outage`,
        entityGenerator: entities.grid?.power_outage?.entity_generator,
      },
      icon: computeFieldIcon(this.hass, entities.grid, "mdi:transmission-tower"),
      name: computeFieldName(this.hass, entities.grid, this.hass.localize("ui.panel.lovelace.cards.energy.energy_distribution.grid")) as
        | string
        | TemplateResult<1>,
      mainEntity:
        typeof entities.grid?.entity === "object" ? entities.grid.entity.consumption || entities.grid.entity.production : entities.grid?.entity,
      color: {
        fromGrid: entities.grid?.color?.consumption,
        toGrid: entities.grid?.color?.production,
        icon_type: entities.grid?.color_icon,
        circle_type: entities.grid?.color_circle,
      },
      secondary: {
        entity: entities.grid?.secondary_info?.entity,
        decimals: entities.grid?.secondary_info?.decimals,
        template: entities.grid?.secondary_info?.template,
        has: entities.grid?.secondary_info?.entity !== undefined,
        state: getGridSecondaryState(this.hass, this._config),
        icon: entities.grid?.secondary_info?.icon,
        unit: entities.grid?.secondary_info?.unit_of_measurement,
        unit_white_space: entities.grid?.secondary_info?.unit_white_space,
        color: {
          type: entities.grid?.secondary_info?.color_value,
        },
      },
    };

    const solar = {
      entity: entities.solar?.entity as string | undefined,
      has: entities.solar?.entity !== undefined,
      state: {
        total: getSolarState(this.hass, this._config),
        toHome: initialNumericState,
        toGrid: initialNumericState,
        toBattery: initialNumericState,
      },
      icon: computeFieldIcon(this.hass, entities.solar, "mdi:solar-power"),
      name: computeFieldName(this.hass, entities.solar, this.hass.localize("ui.panel.lovelace.cards.energy.energy_distribution.solar")),
      secondary: {
        entity: entities.solar?.secondary_info?.entity,
        decimals: entities.solar?.secondary_info?.decimals,
        template: entities.solar?.secondary_info?.template,
        has: entities.solar?.secondary_info?.entity !== undefined,
        state: getSolarSecondaryState(this.hass, this._config),
        icon: entities.solar?.secondary_info?.icon,
        unit: entities.solar?.secondary_info?.unit_of_measurement,
        unit_white_space: entities.solar?.secondary_info?.unit_white_space,
      },
    };

    const battery = {
      entity: entities.battery?.entity,
      has: entities?.battery?.entity !== undefined,
      mainEntity: typeof entities.battery?.entity === "object" ? entities.battery.entity.consumption : entities.battery?.entity,
      name: computeFieldName(this.hass, entities.battery, this.hass.localize("ui.panel.lovelace.cards.energy.energy_distribution.battery")),
      icon: computeFieldIcon(this.hass, entities.battery, "mdi:battery-high"),
      state_of_charge: {
        state: getBatteryStateOfCharge(this.hass, this._config),
        unit: entities?.battery?.state_of_charge_unit || "%",
        unit_white_space: entities?.battery?.state_of_charge_unit_white_space || true,
        decimals: entities?.battery?.state_of_charge_decimals || 0,
      },
      state: {
        toBattery: getBatteryInState(this.hass, this._config),
        fromBattery: getBatteryOutState(this.hass, this._config),
        toGrid: 0,
        toHome: 0,
      },
      color: {
        fromBattery: entities.battery?.color?.consumption,
        toBattery: entities.battery?.color?.production,
        icon_type: undefined as string | boolean | undefined,
        circle_type: entities.battery?.color_circle,
      },
    };

    const home = {
      entity: entities.home?.entity,
      has: entities?.home?.entity !== undefined,
      state: initialNumericState,
      icon: computeFieldIcon(this.hass, entities?.home, "mdi:home"),
      name: computeFieldName(this.hass, entities?.home, this.hass.localize("ui.panel.lovelace.cards.energy.energy_distribution.home")),
      secondary: {
        entity: entities.home?.secondary_info?.entity,
        template: entities.home?.secondary_info?.template,
        has: entities.home?.secondary_info?.entity !== undefined,
        state: getHomeSecondaryState(this.hass, this._config),
        unit: entities.home?.secondary_info?.unit_of_measurement,
        unit_white_space: entities.home?.secondary_info?.unit_white_space,
        icon: entities.home?.secondary_info?.icon,
        decimals: entities.home?.secondary_info?.decimals,
      },
    };

    const getIndividualObject = (field: "individual1" | "individual2") => ({
      entity: entities[field]?.entity,
      has: entities[field]?.entity !== undefined,
      displayZero: entities[field]?.display_zero,
      displayZeroTolerance: entities[field]?.display_zero_tolerance,
      state: getIndividualState(this.hass, this._config, field),
      icon: computeFieldIcon(this.hass, entities[field], field === "individual1" ? "mdi:car-electric" : "mdi:motorbike-electric"),
      name: computeFieldName(this.hass, entities[field], field === "individual1" ? localize("card.label.car") : localize("card.label.motorbike")),
      color: entities[field]?.color,
      unit: entities[field]?.unit_of_measurement,
      unit_white_space: entities[field]?.unit_white_space,
      decimals: entities[field]?.decimals,
      invertAnimation:
        getIndividualState(this.hass, this._config, field) ?? 0 < 0
          ? !entities[field]?.inverted_animation || false
          : entities[field]?.inverted_animation || false,
      showDirection: entities[field]?.show_direction || false,
      secondary: {
        entity: entities[field]?.secondary_info?.entity,
        template: entities[field]?.secondary_info?.template,
        has: entities[field]?.secondary_info?.entity !== undefined,
        state: getSecondaryState(this.hass, this._config, field),
        icon: entities[field]?.secondary_info?.icon,
        unit: entities[field]?.secondary_info?.unit_of_measurement,
        unit_white_space: entities[field]?.secondary_info?.unit_white_space,
        displayZero: entities[field]?.secondary_info?.display_zero,
        displayZeroTolerance: entities[field]?.secondary_info?.display_zero_tolerance,
        decimals: entities[field]?.secondary_info?.decimals,
      },
    });

    const individual1 = getIndividualObject("individual1");

    const individual2 = getIndividualObject("individual2");

    type Individual = typeof individual2 & typeof individual1;

    const nonFossil = {
      entity: entities.fossil_fuel_percentage?.entity,
      name: computeFieldName(this.hass, entities.fossil_fuel_percentage, this.hass.localize("card.label.non_fossil_fuel_percentage")),
      icon: computeFieldIcon(this.hass, entities.fossil_fuel_percentage, "mdi:leaf"),
      has: getNonFossilHas(this.hass, this._config),
      hasPercentage: getNonFossilHasPercentage(this.hass, this._config),
      state: {
        power: initialNumericState,
      },
      color: entities.fossil_fuel_percentage?.color,
      color_value: entities.fossil_fuel_percentage?.color_value,
      secondary: {
        entity: entities.fossil_fuel_percentage?.secondary_info?.entity,
        decimals: entities.fossil_fuel_percentage?.secondary_info?.decimals,
        template: entities.fossil_fuel_percentage?.secondary_info?.template,
        has: entities.fossil_fuel_percentage?.secondary_info?.entity !== undefined,
        state: getNonFossilSecondaryState(this.hass, this._config),
        icon: entities.fossil_fuel_percentage?.secondary_info?.icon,
        unit: entities.fossil_fuel_percentage?.secondary_info?.unit_of_measurement,
        unit_white_space: entities.fossil_fuel_percentage?.secondary_info?.unit_white_space,
        color_value: entities.fossil_fuel_percentage?.secondary_info?.color_value,
      },
    };

    // Reset Values below Display Zero Tolerance
    grid.state.fromGrid = adjustZeroTolerance(grid.state.fromGrid, entities.grid?.display_zero_tolerance);
    grid.state.toGrid = adjustZeroTolerance(grid.state.toGrid, entities.grid?.display_zero_tolerance);
    solar.state.total = adjustZeroTolerance(solar.state.total, entities.solar?.display_zero_tolerance);
    battery.state.fromBattery = adjustZeroTolerance(battery.state.fromBattery, entities.battery?.display_zero_tolerance);
    battery.state.toBattery = adjustZeroTolerance(battery.state.toBattery, entities.battery?.display_zero_tolerance);
    if (grid.state.fromGrid === 0) {
      grid.state.toHome = 0;
      grid.state.toBattery = 0;
    }
    if (solar.state.total === 0) {
      solar.state.toGrid = 0;
      solar.state.toBattery = 0;
      solar.state.toHome = 0;
    }
    if (battery.state.fromBattery === 0) {
      battery.state.toGrid = 0;
      battery.state.toHome = 0;
    }

    if (entities.solar?.color !== undefined) {
      let solarColor = entities.solar?.color;
      if (typeof solarColor === "object") solarColor = convertColorListToHex(solarColor);
      this.style.setProperty("--energy-solar-color", solarColor || "#ff9800");
    }
    this.style.setProperty("--icon-solar-color", entities.solar?.color_icon ? "var(--energy-solar-color)" : "var(--primary-text-color)");

    if (solar.has) {
      solar.state.toHome = (solar.state.total ?? 0) - (grid.state.toGrid ?? 0) - (battery.state.toBattery ?? 0);
    }
    const largestGridBatteryTolerance = Math.max(entities.grid?.display_zero_tolerance ?? 0, entities.battery?.display_zero_tolerance ?? 0);

    if (solar.state.toHome !== null && solar.state.toHome < 0) {
      // What we returned to the grid and what went in to the battery is more
      // than produced, so we have used grid energy to fill the battery or
      // returned battery energy to the grid
      if (battery.has) {
        grid.state.toBattery = Math.abs(solar.state.toHome);
        if (grid.state.toBattery > (grid.state.fromGrid ?? 0)) {
          battery.state.toGrid = Math.min(grid.state.toBattery - (grid.state.fromGrid ?? 0), 0);
          grid.state.toBattery = grid.state.fromGrid;
        }
      }
      solar.state.toHome = 0;
    } else if (battery.state.toBattery && battery.state.toBattery > 0) {
      grid.state.toBattery = battery.state.toBattery;
    }
    grid.state.toBattery = (grid.state.toBattery ?? 0) > largestGridBatteryTolerance ? grid.state.toBattery : 0;

    if (battery.has) {
      if (solar.has) {
        if (!battery.state.toGrid) {
          battery.state.toGrid = Math.max(
            0,
            (grid.state.toGrid || 0) - (solar.state.total || 0) - (battery.state.toBattery || 0) - (grid.state.toBattery || 0)
          );
        }
        solar.state.toBattery = battery.state.toBattery - (grid.state.toBattery || 0);
        if (entities.solar?.display_zero_tolerance) {
          if (entities.solar.display_zero_tolerance >= (solar.state.total || 0)) solar.state.toBattery = 0;
        }
      } else {
        battery.state.toGrid = grid.state.toGrid || 0;
      }
      battery.state.toGrid = (battery.state.toGrid || 0) > largestGridBatteryTolerance ? battery.state.toGrid || 0 : 0;
      battery.state.toHome = (battery.state.fromBattery ?? 0) - (battery.state.toGrid ?? 0);
    }

    grid.state.toHome = Math.max(grid.state.fromGrid - (grid.state.toBattery ?? 0), 0);

    if (solar.has && grid.state.toGrid) solar.state.toGrid = grid.state.toGrid - (battery.state.toGrid ?? 0);

    // Handle Power Outage
    if (grid.powerOutage.isOutage) {
      grid.state.fromGrid = grid.powerOutage.entityGenerator ? Math.max(getEntityStateWatts(this.hass, grid.powerOutage.entityGenerator), 0) : 0;
      grid.state.toHome = Math.max(grid.state.fromGrid - (grid.state.toBattery ?? 0), 0);
      grid.state.toGrid = 0;
      battery.state.toGrid = 0;
      solar.state.toGrid = 0;
      grid.icon = grid.powerOutage.icon;
      nonFossil.has = false;
      nonFossil.hasPercentage = false;
    }

    // Set Initial State for Non Fossil Fuel Percentage
    if (nonFossil.has) {
      const nonFossilFuelDecimal = 1 - (getEntityState(this.hass, entities.fossil_fuel_percentage?.entity) ?? 0) / 100;
      nonFossil.state.power = grid.state.toHome * nonFossilFuelDecimal;
    }

    // Calculate Total Consumptions
    const totalIndividualConsumption = coerceNumber(individual1.state, 0) + coerceNumber(individual2.state, 0);

    const totalHomeConsumption = Math.max(grid.state.toHome + (solar.state.toHome ?? 0) + (battery.state.toHome ?? 0), 0);

    // Calculate Circumferences
    const homeBatteryCircumference = battery.state.toHome ? circleCircumference * (battery.state.toHome / totalHomeConsumption) : 0;
    const homeSolarCircumference = solar.state.toHome ? circleCircumference * (solar.state.toHome / totalHomeConsumption) : 0;
    const homeNonFossilCircumference = nonFossil.state.power ? circleCircumference * (nonFossil.state.power / totalHomeConsumption) : 0;
    const homeGridCircumference =
      circleCircumference *
      ((totalHomeConsumption - (nonFossil.state.power ?? 0) - (battery.state.toHome ?? 0) - (solar.state.toHome ?? 0)) / totalHomeConsumption);

    const homeUsageToDisplay =
      entities.home?.override_state && entities.home.entity
        ? entities.home?.subtract_individual
          ? displayValue(this.hass, getEntityStateWatts(this.hass, entities.home.entity) - totalIndividualConsumption)
          : displayValue(this.hass, getEntityStateWatts(this.hass, entities.home!.entity))
        : entities.home?.subtract_individual
        ? displayValue(this.hass, totalHomeConsumption - totalIndividualConsumption || 0)
        : displayValue(this.hass, totalHomeConsumption);

    const totalLines =
      grid.state.toHome +
      (solar.state.toHome ?? 0) +
      (solar.state.toGrid ?? 0) +
      (solar.state.toBattery ?? 0) +
      (battery.state.toHome ?? 0) +
      (grid.state.toBattery ?? 0) +
      (battery.state.toGrid ?? 0);

    // Battery SoC
    if (battery.state_of_charge.state === null) {
      battery.icon = "mdi:battery";
    } else if (battery.state_of_charge.state <= 72 && battery.state_of_charge.state > 44) {
      battery.icon = "mdi:battery-medium";
    } else if (battery.state_of_charge.state <= 44 && battery.state_of_charge.state > 16) {
      battery.icon = "mdi:battery-low";
    } else if (battery.state_of_charge.state <= 16) {
      battery.icon = "mdi:battery-outline";
    }
    if (entities.battery?.icon !== undefined) battery.icon = entities.battery?.icon;

    // Compute durations
    const newDur: NewDur = {
      batteryGrid: computeFlowRate(this._config, grid.state.toBattery ?? battery.state.toGrid ?? 0, totalLines),
      batteryToHome: computeFlowRate(this._config, battery.state.toHome ?? 0, totalLines),
      gridToHome: computeFlowRate(this._config, grid.state.toHome, totalLines),
      solarToBattery: computeFlowRate(this._config, solar.state.toBattery ?? 0, totalLines),
      solarToGrid: computeFlowRate(this._config, solar.state.toGrid ?? 0, totalLines),
      solarToHome: computeFlowRate(this._config, solar.state.toHome ?? 0, totalLines),
      individual1: computeFlowRate(this._config, individual1.state ?? 0, totalIndividualConsumption),
      individual2: computeFlowRate(this._config, individual2.state ?? 0, totalIndividualConsumption),
      nonFossil: computeFlowRate(this._config, nonFossil.state.power ?? 0, totalLines),
    };

    // Smooth duration changes
    ["batteryGrid", "batteryToHome", "gridToHome", "solarToBattery", "solarToGrid", "solarToHome"].forEach((flowName) => {
      const flowSVGElement = this[`${flowName}Flow`] as SVGSVGElement;
      if (flowSVGElement && this.previousDur[flowName] && this.previousDur[flowName] !== newDur[flowName]) {
        flowSVGElement.pauseAnimations();
        flowSVGElement.setCurrentTime(flowSVGElement.getCurrentTime() * (newDur[flowName] / this.previousDur[flowName]));
        flowSVGElement.unpauseAnimations();
      }
      this.previousDur[flowName] = newDur[flowName];
    });

    const homeSources: HomeSources = {
      battery: {
        value: homeBatteryCircumference,
        color: "var(--energy-battery-out-color)",
      },
      solar: {
        value: homeSolarCircumference,
        color: "var(--energy-solar-color)",
      },
      grid: {
        value: homeGridCircumference,
        color: "var(--energy-grid-consumption-color)",
      },
      gridNonFossil: {
        value: homeNonFossilCircumference,
        color: "var(--energy-non-fossil-color)",
      },
    };

    /* return source object with largest value property */
    const homeLargestSource = Object.keys(homeSources).reduce((a, b) => (homeSources[a].value > homeSources[b].value ? a : b));

    const getIndividualDisplayState = (field: Individual) => {
      if (field.state === undefined) return "";
      return displayValue(this.hass, field.state, field.unit, field.unit_white_space, field.decimals);
    };

    const individual1DisplayState = getIndividualDisplayState(individual1);

    const individual2DisplayState = getIndividualDisplayState(individual2);

    // Templates
    const templatesObj: TemplatesObj = {
      gridSecondary: this._templateResults.gridSecondary?.result,
      solarSecondary: this._templateResults.solarSecondary?.result,
      homeSecondary: this._templateResults.homeSecondary?.result,
      individual1Secondary: this._templateResults.individual1Secondary?.result,
      individual2Secondary: this._templateResults.individual2Secondary?.result,
      nonFossilFuelSecondary: this._templateResults.nonFossilFuelSecondary?.result,
    };

    // Styles
    const isCardWideEnough = this._width > 420;
    allDynamicStyles(this, {
      grid,
      solar,
      battery,
      display_zero_lines_grey_color: this._config.display_zero_lines?.mode === "grey_out" ? this._config.display_zero_lines?.grey_color : "",
      display_zero_lines_transparency: this._config.display_zero_lines?.mode === "transparency" ? this._config.display_zero_lines?.transparency : "",
      entities,
      homeLargestSource,
      homeSources,
      individual1,
      individual2,
      nonFossil,
      isCardWideEnough,
    });

    return html`
      <ha-card
        .header=${this._config.title}
        class=${this._config.full_size ? "full-size" : ""}
        style=${this._config.style_ha_card ? this._config.style_ha_card : ""}
      >
        <div
          class="card-content ${this._config.full_size ? "full-size" : ""}"
          id="power-flow-card-plus"
          style=${this._config.style_card_content ? this._config.style_card_content : ""}
        >
          ${solar.has || individual2.has || individual1.has || nonFossil.hasPercentage
            ? html`<div class="row">
                ${nonFossilElement(this, this._config, {
                  entities,
                  grid,
                  newDur,
                  nonFossil,
                  templatesObj,
                })}
                ${solar.has
                  ? solarElement(this, {
                      entities,
                      solar,
                      templatesObj,
                    })
                  : individual2.has || individual1.has
                  ? html`<div class="spacer"></div>`
                  : ""}
                ${individual2.has
                  ? individual2Element(this, {
                      entities,
                      individual2,
                      individual2DisplayState,
                      newDur,
                      templatesObj,
                    })
                  : individual1.has
                  ? html`<div class="circle-container individual1">
                      <span class="label">${individual1.name}</span>
                      <div
                        class="circle"
                        @click=${(e: { stopPropagation: () => void }) => {
                          this.openDetails(e, entities.individual1?.entity);
                        }}
                        @keyDown=${(e: { key: string; stopPropagation: () => void }) => {
                          if (e.key === "Enter") {
                            this.openDetails(e, entities.individual1?.entity);
                          }
                        }}
                      >
                        ${individualSecondarySpan(this.hass, this, templatesObj, individual1, "individual1")}
                        <ha-icon
                          id="individual1-icon"
                          .icon=${individual1.icon}
                          style="${individual1.secondary.has ? "padding-top: 2px;" : "padding-top: 0px;"}
                          ${entities.individual1?.display_zero_state !== false || (individual1.state || 0) > (individual1.displayZeroTolerance ?? 0)
                            ? "padding-bottom: 2px;"
                            : "padding-bottom: 0px;"}"
                        ></ha-icon>
                        ${entities.individual1?.display_zero_state !== false || (individual1.state || 0) > (individual1.displayZeroTolerance ?? 0)
                          ? html` <span class="individual1"
                              >${individual1.showDirection
                                ? html`<ha-icon class="small" .icon=${individual1.invertAnimation ? "mdi:arrow-down" : "mdi:arrow-up"}></ha-icon>`
                                : ""}${individual1DisplayState}
                            </span>`
                          : ""}
                      </div>
                      ${this.showLine(individual1.state || 0)
                        ? html`
                            <svg width="80" height="30">
                              <path d="M40 -10 v40" id="individual1" class="${styleLine(individual1.state || 0, this._config)}" />
                              ${individual1.state
                                ? svg`<circle
                                r="2.4"
                                class="individual1"
                                vector-effect="non-scaling-stroke"
                              >
                                <animateMotion
                                  dur="${this.additionalCircleRate(entities.individual1?.calculate_flow_rate, newDur.individual1)}s"
                                  repeatCount="indefinite"
                                  calcMode="linear"
                                  keyPoints=${individual1.invertAnimation ? "0;1" : "1;0"}
                                  keyTimes="0;1"

                                >
                                  <mpath xlink:href="#individual1" />
                                </animateMotion>
                              </circle>`
                                : ""}
                            </svg>
                          `
                        : html``}
                    </div> `
                  : html`<div class="spacer"></div>`}
              </div>`
            : html``}
          <div class="row">
            ${grid.has
              ? gridElement(this, {
                  entities,
                  grid,
                  templatesObj,
                })
              : html`<div class="spacer"></div>`}
            ${homeElement(this, {
              circleCircumference,
              entities,
              grid,
              home,
              homeBatteryCircumference,
              homeGridCircumference,
              homeNonFossilCircumference,
              homeSolarCircumference,
              newDur,
              templatesObj,
              homeUsageToDisplay,
              individual1,
              individual2,
            })}
          </div>
          ${battery.has || (individual1.has && individual2.has)
            ? html`<div class="row">
                <div class="spacer"></div>
                ${battery.has ? batteryElement(this, { battery, entities }) : html`<div class="spacer"></div>`}
                ${individual2.has && individual1.has
                  ? html`<div class="circle-container individual1 bottom">
                      ${this.showLine(individual1.state || 0)
                        ? html`
                            <svg width="80" height="30">
                              <path d="M40 40 v-40" id="individual1" class="${styleLine(individual1.state || 0, this._config)}" />
                              ${individual1.state
                                ? svg`<circle
                                r="2.4"
                                class="individual1"
                                vector-effect="non-scaling-stroke"
                              >
                                <animateMotion
                                  dur="${this.additionalCircleRate(entities.individual1?.calculate_flow_rate, newDur.individual1)}s"
                                  repeatCount="indefinite"
                                  calcMode="linear"
                                  keyPoints=${individual1.invertAnimation ? "0;1" : "1;0"}
                                  keyTimes="0;1"
                                >
                                  <mpath xlink:href="#individual1" />
                                </animateMotion>
                              </circle>`
                                : ""}
                            </svg>
                          `
                        : html` <svg width="80" height="30"></svg> `}
                      <div
                        class="circle"
                        @click=${(e: { stopPropagation: () => void }) => {
                          this.openDetails(e, entities.individual1?.entity);
                        }}
                        @keyDown=${(e: { key: string; stopPropagation: () => void }) => {
                          if (e.key === "Enter") {
                            this.openDetails(e, entities.individual1?.entity);
                          }
                        }}
                      >
                        ${individualSecondarySpan(this.hass, this, templatesObj, individual1, "individual1")}
                        <ha-icon
                          id="individual1-icon"
                          .icon=${individual1.icon}
                          style="${individual1.secondary.has ? "padding-top: 2px;" : "padding-top: 0px;"}
                          ${entities.individual1?.display_zero_state !== false || (individual1.state || 0) > (individual1.displayZeroTolerance ?? 0)
                            ? "padding-bottom: 2px;"
                            : "padding-bottom: 0px;"}"
                        ></ha-icon>
                        ${entities.individual1?.display_zero_state !== false || (individual1.state || 0) > (individual1.displayZeroTolerance ?? 0)
                          ? html` <span class="individual1"
                              >${individual1.showDirection
                                ? html`<ha-icon class="small" .icon=${individual1.invertAnimation ? "mdi:arrow-up" : "mdi:arrow-down"}></ha-icon>`
                                : ""}${individual1DisplayState}
                            </span>`
                          : ""}
                      </div>
                      <span class="label">${individual1.name}</span>
                    </div>`
                  : html`<div class="spacer"></div>`}
              </div>`
            : html`<div class="spacer"></div>`}
          ${flowElement(this, this._config, {
            battery,
            grid,
            individual1,
            individual2,
            newDur,
            solar,
          })}
        </div>
        ${dashboardLinkElement(this._config, this.hass)}
      </ha-card>
    `;
  }

  protected updated(changedProps: PropertyValues): void {
    super.updated(changedProps);
    if (!this._config || !this.hass) {
      return;
    }

    const elem = this?.shadowRoot?.querySelector("#power-flow-card-plus");
    const widthStr = elem ? getComputedStyle(elem).getPropertyValue("width") : "0px";
    this._width = parseInt(widthStr.replace("px", ""), 10);

    this._tryConnectAll();
  }

  private _tryConnectAll() {
    const { entities } = this._config;
    const templatesObj = {
      gridSecondary: entities.grid?.secondary_info?.template,
      solarSecondary: entities.solar?.secondary_info?.template,
      homeSecondary: entities.home?.secondary_info?.template,
      individual1Secondary: entities.individual1?.secondary_info?.template,
      individual2Secondary: entities.individual2?.secondary_info?.template,
      nonFossilFuelSecondary: entities.fossil_fuel_percentage?.secondary_info?.template,
    };

    for (const [key, value] of Object.entries(templatesObj)) {
      if (value) {
        this._tryConnect(value, key);
      }
    }
  }

  private async _tryConnect(inputTemplate: string, topic: string): Promise<void> {
    if (!this.hass || !this._config || this._unsubRenderTemplates?.get(topic) !== undefined || inputTemplate === "") {
      return;
    }

    try {
      const sub = subscribeRenderTemplate(
        this.hass.connection,
        (result) => {
          this._templateResults[topic] = result;
        },
        {
          template: inputTemplate,
          entity_ids: this._config.entity_id,
          variables: {
            config: this._config,
            user: this.hass.user!.name,
          },
          strict: true,
        }
      );
      this._unsubRenderTemplates?.set(topic, sub);
      await sub;
    } catch (_err) {
      this._templateResults = {
        ...this._templateResults,
        [topic]: {
          result: inputTemplate,
          listeners: { all: false, domains: [], entities: [], time: false },
        },
      };
      this._unsubRenderTemplates?.delete(topic);
    }
  }

  private async _tryDisconnectAll() {
    const { entities } = this._config;
    const templatesObj = {
      gridSecondary: entities.grid?.secondary_info?.template,
      solarSecondary: entities.solar?.secondary_info?.template,
      homeSecondary: entities.home?.secondary_info?.template,

      individual1Secondary: entities.individual1?.secondary_info?.template,
      individual2Secondary: entities.individual2?.secondary_info?.template,
    };

    for (const [key, value] of Object.entries(templatesObj)) {
      if (value) {
        this._tryDisconnect(key);
      }
    }
  }

  private async _tryDisconnect(topic: string): Promise<void> {
    const unsubRenderTemplate = this._unsubRenderTemplates?.get(topic);
    if (!unsubRenderTemplate) {
      return;
    }

    try {
      const unsub = await unsubRenderTemplate;
      unsub();
      this._unsubRenderTemplates?.delete(topic);
    } catch (err: any) {
      if (err.code === "not_found" || err.code === "template_error") {
        // If we get here, the connection was probably already closed. Ignore.
      } else {
        throw err;
      }
    }
  }

  static styles = styles;
}
