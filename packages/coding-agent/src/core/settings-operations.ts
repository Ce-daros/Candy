import {
	INTERACTIVE_SETTINGS,
	type InteractiveSettingId,
	type InteractiveSettingReadValue,
} from "./interactive-setting-values.ts";
import type { SettingsManager, SettingsScope } from "./settings-manager.ts";
import type { SettingValueSource } from "./settings-types.ts";

export function isInteractiveSettingId(value: string): value is InteractiveSettingId {
	return Object.hasOwn(INTERACTIVE_SETTINGS, value);
}

export async function commitInteractiveSetting(
	settings: SettingsManager,
	scope: SettingsScope,
	id: InteractiveSettingId,
	value: unknown,
	options: { clear?: boolean } = {},
): Promise<void> {
	const definition = INTERACTIVE_SETTINGS[id];
	const clear = options.clear ?? false;
	if (scope !== "global" && scope !== "project") throw new Error(`Invalid settings scope: ${String(scope)}`);
	if (!definition.writableScopes.includes(scope)) {
		throw new Error(`Setting ${id} can only be saved ${definition.writableScopes.join(" or ")}`);
	}
	if (!clear && !definition.values.some((candidate) => Object.is(candidate, value))) {
		throw new Error(`Invalid value for setting ${id}`);
	}
	const committedValue = clear ? undefined : (value as never);
	if (definition.location.nestedPath === undefined) {
		await settings.commitSetting(scope, definition.location.field, committedValue);
	} else {
		await settings.commitNestedSetting(
			scope,
			definition.location.field,
			definition.location.nestedPath,
			committedValue,
		);
	}
}

export function getInteractiveSettingState<Id extends InteractiveSettingId>(
	settings: SettingsManager,
	id: Id,
): {
	value: InteractiveSettingReadValue<Id>;
	source: SettingValueSource;
	writableScopes: readonly SettingsScope[];
} {
	const definition = INTERACTIVE_SETTINGS[id];
	return {
		value: settings.read(id) as InteractiveSettingReadValue<Id>,
		source: settings.getSettingSource(definition.location.field, definition.location.nestedPath),
		writableScopes: definition.writableScopes,
	};
}
