const BUTTON_LABELS = [
    "BUTTON_1", "BUTTON_2", "BUTTON_3", "BUTTON_4",
    "LEFT_TOP_SHOULDER", "RIGHT_TOP_SHOULDER", "LEFT_BOTTOM_SHOULDER", "RIGHT_BOTTOM_SHOULDER",
    "SELECT", "START", "LEFT_STICK", "RIGHT_STICK",
    "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"
];
const AXIS_LABELS = ["LEFT_STICK_X", "LEFT_STICK_Y", "RIGHT_STICK_X", "RIGHT_STICK_Y"];
const DEAD_ZONE = 0.01;
const IDLE_SCAN_MS = 500;
const HIDDEN_POLL_MS = 250;

const deadZone = (value) => (value < DEAD_ZONE && value > -DEAD_ZONE ? 0 : value);

/**
 * Polls connected gamepads and dispatches connected, disconnected, buttondown,
 * buttonup and axischanged events. Polling follows display frames while pads are
 * connected and drops to a slow scan while none are.
 */
class GamepadHandler {
    constructor() {
        this.buttonLabels = BUTTON_LABELS;
        this.gamepads = [];
        this.listeners = {};
        this.timeout = null;
        this.frame = null;
        this.terminated = false;
        this.loop = this.loop.bind(this);
        this.onVisibility = () => this.schedule();
        document.addEventListener("visibilitychange", this.onVisibility);
        window.addEventListener("gamepadconnected", this.onVisibility);
        // Wait a tick before the first poll so listeners can attach first
        this.timeout = setTimeout(this.loop, 0);
    }
    terminate() {
        this.terminated = true;
        clearTimeout(this.timeout);
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.timeout = null;
        this.frame = null;
        document.removeEventListener("visibilitychange", this.onVisibility);
        window.removeEventListener("gamepadconnected", this.onVisibility);
    }
    getGamepads() {
        if (navigator.getGamepads) return navigator.getGamepads();
        if (navigator.webkitGetGamepads) return navigator.webkitGetGamepads();
        return [];
    }
    schedule() {
        if (this.terminated) return;
        clearTimeout(this.timeout);
        if (this.frame !== null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
        if (this.gamepads.length === 0) {
            this.timeout = setTimeout(this.loop, IDLE_SCAN_MS);
        } else if (document.hidden) {
            this.timeout = setTimeout(this.loop, HIDDEN_POLL_MS);
        } else {
            this.frame = requestAnimationFrame(this.loop);
        }
    }
    loop() {
        this.frame = null;
        this.updateGamepadState();
        this.schedule();
    }
    findKnown(index) {
        for (let i = 0; i < this.gamepads.length; i++) {
            if (this.gamepads[i].index === index) return this.gamepads[i];
        }
        return null;
    }
    updateGamepadState() {
        const live = this.getGamepads();
        const seen = new Set();

        for (let n = 0; n < live.length; n++) {
            const pad = live[n];
            if (!pad) continue;
            seen.add(pad.index);
            const known = this.findKnown(pad.index);
            if (!known) {
                this.addGamepad(pad);
                continue;
            }
            this.diffAxes(known, pad);
            this.diffButtons(known, pad);
        }

        for (let j = this.gamepads.length - 1; j >= 0; j--) {
            const known = this.gamepads[j];
            if (!seen.has(known.index)) {
                this.gamepads.splice(j, 1);
                this.dispatchEvent("disconnected", { gamepadIndex: known.index });
            }
        }
    }
    addGamepad(pad) {
        const record = { axes: [], buttons: {}, index: pad.index, id: pad.id };
        for (let i = 0; i < pad.axes.length; i++) record.axes[i] = deadZone(pad.axes[i]);
        for (let i = 0; i < pad.buttons.length; i++) record.buttons[i] = { pressed: this.isPressed(pad.buttons[i]) };
        this.gamepads.push(record);
        this.gamepads.sort((a, b) => a.index - b.index);
        this.dispatchEvent("connected", { gamepadIndex: pad.index });
    }
    isPressed(button) {
        return typeof button === "object" ? button.pressed : button === 1.0;
    }
    diffAxes(known, pad) {
        const count = Math.max(known.axes.length, pad.axes.length);
        for (let i = 0; i < count; i++) {
            const oldValue = known.axes[i] === undefined ? 0 : known.axes[i];
            const newValue = pad.axes[i] === undefined ? 0 : deadZone(pad.axes[i]);
            if (newValue === oldValue) continue;
            known.axes[i] = newValue;
            const axis = AXIS_LABELS[i] || "EXTRA_STICK_" + i;
            this.dispatchEvent("axischanged", {
                axis: axis,
                value: newValue,
                oldValue: oldValue,
                index: pad.index,
                label: this.getAxisLabel(axis, newValue),
                gamepadIndex: pad.index
            });
        }
    }
    diffButtons(known, pad) {
        for (let i = 0; i < pad.buttons.length; i++) {
            const pressed = this.isPressed(pad.buttons[i]);
            const was = known.buttons[i] ? known.buttons[i].pressed : false;
            if (pressed === was) continue;
            known.buttons[i] = { pressed: pressed };
            this.dispatchEvent(pressed ? "buttondown" : "buttonup", {
                index: i,
                label: this.getButtonLabel(i),
                gamepadIndex: pad.index
            });
        }
    }
    dispatchEvent(name, arg) {
        const listener = this.listeners[name];
        if (typeof listener !== "function") return;
        arg = arg || {};
        arg.type = name;
        listener(arg);
    }
    on(name, cb) {
        this.listeners[name.toLowerCase()] = cb;
    }
    getButtonLabel(index) {
        if (index === null || index === undefined) return null;
        return BUTTON_LABELS[index] === undefined ? `GAMEPAD_${index}` : BUTTON_LABELS[index];
    }
    getAxisLabel(axis, value) {
        if (!axis || (value <= 0.5 && value >= -0.5)) return null;
        return `${axis}:${value > 0 ? "+1" : "-1"}`;
    }
}

export { GamepadHandler };
