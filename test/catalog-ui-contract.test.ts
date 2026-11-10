import { expectTypeOf, it } from 'vitest';
import type { ModelCatalogView, ModelValidation as BackendValidation } from '../src/ai/model-catalog/index.js';
import type { ProviderSettingsSnapshot, ModelValidation } from '../web/src/app/ai-settings/provider-settings-port.js';
it('Angular wire-only DTOs match catalog v1 without a backend runtime import', () => {
  expectTypeOf<ProviderSettingsSnapshot>().toExtend<ModelCatalogView>();
  expectTypeOf<ModelCatalogView>().toExtend<ProviderSettingsSnapshot>();
  expectTypeOf<keyof ProviderSettingsSnapshot>().toEqualTypeOf<keyof ModelCatalogView>();
  expectTypeOf<ModelValidation>().toEqualTypeOf<BackendValidation>();
});
