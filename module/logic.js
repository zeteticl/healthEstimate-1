import * as providers from "./EstimationProvider.js";
import { registerSettings } from "./settings.js";
import { addSetting, isEmpty, sGet, t } from "./utils.js";

export class HealthEstimate {
	/** Changes which users get to see the overlay. */
	breakConditions = {
		default: `false`,
	};

	//Hooks
	setup() {
		this.estimationProvider = this.prepareSystemSpecifics();
		this.fractionFormula = this.estimationProvider.fraction;
		if (this.estimationProvider.breakCondition !== undefined) this.breakConditions.system = this.estimationProvider.breakCondition;
		if (this.estimationProvider.tokenEffects !== undefined) this.tokenEffectsPath = this.estimationProvider.tokenEffects;
		registerSettings();
		for (let [key, data] of Object.entries(this.estimationProvider.settings)) {
			addSetting(key, data);
		}
		this.updateBreakConditions();
		this.updateSettings();
	}

	/**
	 * Gets system specifics, such as its hp attribute and other settings.
	 * @returns {providers.EstimationProvider}
	 */
	prepareSystemSpecifics() {
		let supportedSystems = "";
		let providerArray = Object.keys(providers);
		if (providerArray.includes("EstimationProvider")) {
			const index = providerArray.indexOf("EstimationProvider");
			providerArray.splice(index, 1);
		}
		if (providerArray.includes("GenericEstimationProvider")) {
			const index = providerArray.indexOf("GenericEstimationProvider");
			providerArray.splice(index, 1);
		}
		providerArray.forEach(function (string, index, array) {
			if (index === array.length - 1) supportedSystems += string.replace("EstimationProvider", "");
			else supportedSystems += string.replace("EstimationProvider", "") + "|";
		});
		const systemsRegex = new RegExp(supportedSystems);
		if (systemsRegex.test(game.system.id)) var providerString = game.system.id;
		else providerString = providers.providerKeys[game.system.id] || "Generic";

		return eval(`new providers.${providerString}EstimationProvider("native${providerString.length ? "." + providerString : ""}")`);
	}

	canvasInit(canvas) {
		this.combatRunning = this.isCombatRunning();
	}

	/**
	 * Sets all the hooks related to a game with a canvas enabled.
	 */
	canvasReady() {
		this.actorsCurrentHP = {};
		this.combatOnly = sGet("core.combatOnly");
		if (this.combatOnly) this.combatHooks(this.combatOnly);
		this.alwaysShow = sGet("core.alwaysShow");
		this.combatRunning = this.isCombatRunning();
		Hooks.on("refreshToken", (token) => {
			this._handleOverlay(token, this.showCondition(token.hover));
		});
		Hooks.on("hoverToken", (token, hovered) => {
			this._handleOverlay(token, this.showCondition(hovered));
		});
		if (this.scaleToZoom) {
			Hooks.on("canvasPan", (canvas, constrained) => {
				canvas.scene.tokens.forEach((token) => token.object.refresh());
			});
		}
		if (this.alwaysShow) {
			canvas.scene.tokens.forEach((token) => token.object.refresh());
			Hooks.on("updateActor", this.alwaysOnUpdateActor);
			if (!game.version > 11) Hooks.on("updateToken", this.alwaysOnUpdateToken);
		}
		Hooks.on("canvasInit", this.canvasInit.bind(this));
	}

	/**
	 * @param {Token} token
	 * @param {Boolean} hovered
	 */
	_handleOverlay(token, hovered) {
		if (token.healthEstimate?._texture) token.healthEstimate.destroy();
		if (!token?.actor) return;
		if (this.breakOverlayRender(token) || (!game.user.isGM && this.hideEstimate(token))) return;

		if (hovered) {
			if (!token.isVisible) return;
			const { desc, color, stroke } = this.getEstimation(token);
			if (!desc) return;

			const zoomLevel = Math.min(1, canvas.stage.scale.x);
			const userTextStyle = this._getUserTextStyle(zoomLevel, color, stroke);
			token.healthEstimate = token.addChild(new PIXI.Text(desc, userTextStyle));

			token.healthEstimate.scale.x = 0.25;
			token.healthEstimate.scale.y = 0.25;
			token.healthEstimate.anchor.x = 0.5;
			if (!this.scaleToZoom || (this.scaleToZoom && zoomLevel >= 1)) token.healthEstimate.anchor.y = this.margin;

			token.healthEstimate.x = Math.floor((canvas.scene.grid.size * token.document.width) / 2);
			token.healthEstimate.y = isNaN(Number(this.alignment)) ? -65 : this.alignment;
		} else if (token.healthEstimate) token.healthEstimate.visible = false;
	}

	_getUserTextStyle(zoomLevel, color, stroke) {
		if (this.scaleToZoom && zoomLevel < 1) var fontSize = 24 * (1 / zoomLevel);
		else fontSize = isNaN(Number(this.fontSize)) ? 24 : this.fontSize;
		// Trick to render text at a higher resolution, it'll be scaled down to the same size.
		fontSize *= 4;

		return {
			fontSize,
			fontFamily: CONFIG.canvasTextStyle.fontFamily,
			fill: color,
			stroke,
			strokeThickness: 12,
			padding: 5,
		};
	}

	/**
	 * Returns an array of estimates related to the token.
	 * deepClone is used here because changes will reflect locally on the estimations setting (see {@link getEstimation})
	 * @param {TokenDocument} token
	 * @returns
	 */
	getTokenEstimate(token) {
		let special;
		for (var estimation of this.estimations) {
			if (["default", ""].includes(estimation.rule)) continue;
			let isEstimationValid = (token) => {
				return new Function(
					`token`,
					`
				${this.estimationProvider.customLogic}
				return ${estimation.rule}`
				)(token);
			};
			if (isEstimationValid(token)) {
				if (estimation.ignoreColor) {
					special = estimation;
				} else return { estimation: deepClone(estimation), special: deepClone(special) };
			}
		}
		return { estimation: deepClone(this.estimations[0]), special: deepClone(special) };
	}

	/**
	 * Returns the token's estimate's description, color and stroke outline.
	 * @param {TokenDocument} token
	 * @returns {{desc: String, color: String, stroke: String}}
	 */
	getEstimation(token) {
		try {
			const fraction = Number(this.getFraction(token));
			const { estimate, index } = this.getStage(token, fraction);
			const isDead = this.isDead(token, estimate.value);

			const colorIndex = this.smoothGradient ? Math.max(0, Math.ceil((this.colors.length - 1) * fraction)) : index;
			if (isDead) {
				estimate.label = this.deathStateName;
				var color = this.deadColor;
				var stroke = this.deadOutline;
			} else {
				color = this.colors[colorIndex];
				stroke = this.outline[colorIndex];
			}
			if (this.hideEstimate(token)) var desc = estimate.label + "*";
			else desc = estimate.label;
			return { desc, color, stroke };
		} catch (err) {
			console.error(`Health Estimate | Error on getEstimation(). Token Name: "${token.name}". Type: "${token.document.actor.type}".`, err);
		}
	}

	/**
	 * Returns the current health fraction of the token.
	 * @param {TokenDocument} token
	 * @returns {Number}
	 */
	getFraction(token) {
		return Math.max(0, Math.min(this.fractionFormula(token), 1));
	}

	/**
	 * @typedef {Object} Estimate
	 * @property {string} label
	 * @property {number} value
	 */
	/**
	 * Returns the estimate and its index.
	 * @param {TokenDocument} token
	 * @param {Number} fraction
	 * @returns {{estimate: Estimate, index: number}}
	 */
	getStage(token, fraction) {
		try {
			const { estimation, special } = this.getTokenEstimate(token);
			fraction *= 100;
			// for cases where 1% > fraction > 0%
			if (fraction != 0 && Math.floor(fraction) == 0) fraction = 0.1;
			else fraction = Math.trunc(fraction);
			const logic = (e) => e.value >= fraction;
			const estimate = special ? special.estimates.find(logic) : estimation.estimates.find(logic) ?? { value: fraction, label: "" };
			const index = estimation.estimates.findIndex(logic);
			return { estimate, index };
		} catch (err) {
			console.error(`Health Estimate | Error on getStage(). Token Name: "${token.name}". Type: "${token.document.actor.type}".`, err);
		}
	}

	//Utils
	hideEstimate(token) {
		return token.document.getFlag("healthEstimate", "hideHealthEstimate") || token.actor.getFlag("healthEstimate", "hideHealthEstimate");
	}

	//Hooked functions don't interact correctly with "this"
	alwaysOnUpdateActor(actor, updates, options, userId) {
		//Get all the tokens on the off-chance there's two tokens of the same linked actor.
		let tokens = canvas.tokens?.placeables.filter((e) => e.actor && actor.id == e.actor.id);
		for (let token of tokens) {
			game.healthEstimate._handleOverlay(token, true);
		}
	}
	alwaysOnUpdateToken(tokenDocument, updates, options, userId) {
		game.healthEstimate._handleOverlay(tokenDocument.object, true);
	}

	combatStart(combat, updateData) {
		game.healthEstimate.combatRunning = true;
	}

	deleteCombat(combat, options, userId) {
		game.healthEstimate.combatRunning = game.healthEstimate.isCombatRunning();
	}

	combatHooks(value) {
		if (value) {
			Hooks.on("combatStart", game.healthEstimate.combatStart);
			Hooks.on("deleteCombat", game.healthEstimate.deleteCombat);
		} else {
			Hooks.off("combatStart", game.healthEstimate.combatStart);
			Hooks.off("deleteCombat", game.healthEstimate.deleteCombat);
		}
	}

	isCombatRunning() {
		return [...game.combats].some((combat) => combat.started && (combat._source.scene == canvas.scene._id || combat._source.scene == null));
	}

	/**
	 * Returns if a token is dead.
	 * A token is dead if:
	 * (a) is a NPC at 0 HP and the NPCsJustDie setting is enabled
	 * (b) has been set as dead in combat (e.g. it has the skull icon, icon may vary from system to system) and the showDead setting is enabled
	 * (c) has the healthEstimate.dead flag, which is set by a macro.
	 * @param {TokenDocument} token
	 * @param {Integer} stage
	 * @returns {Boolean}
	 */
	isDead(token, stage) {
		return (
			(this.estimationProvider.organicTypes.includes(token.actor.type) &&
				((this.NPCsJustDie && !token.actor.hasPlayerOwner && stage === 0 && !token.document.getFlag("healthEstimate", "dontMarkDead")) ||
					(this.showDead && this.tokenEffectsPath(token)) ||
					token.document.getFlag("healthEstimate", "dead"))) ||
			false
		);
	}

	showCondition(hovered) {
		const combatTrigger = this.combatOnly && this.combatRunning;
		return (this.alwaysShow && (combatTrigger || !this.combatOnly)) || (hovered && (combatTrigger || !this.combatOnly));
	}

	/**
	 * Path of the token's effects. Useful for systems that change how it is handled (e.g. PF2e, DSA5, SWADE).
	 */
	tokenEffectsPath(token) {
		return Array.from(token.actor.effects.values()).some((x) => x.icon === game.healthEstimate.deathMarker);
	}

	updateBreakConditions() {
		this.breakConditions.onlyGM = sGet("core.showDescription") == 1 ? `|| !game.user.isGM` : ``;
		this.breakConditions.onlyNotGM = sGet("core.showDescription") == 2 ? `|| game.user.isGM` : ``;

		this.breakConditions.onlyPCs = sGet("core.showDescriptionTokenType") == 1 ? `|| !token.actor.hasPlayerOwner` : ``;
		this.breakConditions.onlyNPCs = sGet("core.showDescriptionTokenType") == 2 ? `|| token.actor.hasPlayerOwner` : ``;

		const prep = (key) => {
			if (isEmpty(this.breakConditions[key])) return "";
			return this.breakConditions[key];
		};

		this.breakOverlayRender = function (token) {
			return new Function(
				`token`,
				`return (
					${prep("default")}
					${prep("onlyGM")}
					${prep("onlyNotGM")}
					${prep("onlyNPCs")}
					${prep("onlyPCs")}
					${prep("system")}
				)`
			)(token);
		};
	}

	/**
	 * Variables for settings to avoid multiple system calls for them, since the estimate can be called really often.
	 * Updates the variables if any setting was changed.
	 */
	updateSettings() {
		this.descriptions = sGet("core.stateNames").split(/[,;]\s*/);
		this.estimations = sGet("core.estimations");
		this.deathStateName = sGet("core.deathStateName");
		this.showDead = sGet("core.deathState");
		this.NPCsJustDie = sGet("core.NPCsJustDie");
		this.deathMarker = sGet("core.deathMarker");
		this.scaleToZoom = sGet("core.menuSettings.scaleToZoom");

		this.smoothGradient = sGet("core.menuSettings.smoothGradient");

		this.alignment = sGet("core.menuSettings.position");
		this.margin = sGet("core.menuSettings.positionAdjustment");
		this.fontSize = sGet("core.menuSettings.fontSize");

		this.colors = sGet("core.variables.colors");
		this.outline = sGet("core.variables.outline");
		this.deadColor = sGet("core.variables.deadColor");
		this.deadOutline = sGet("core.variables.deadOutline");
	}
}
