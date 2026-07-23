import { describe, it, expect, beforeEach } from 'vitest';
import { useAppVersionStore } from './app-version';

describe('useAppVersionStore', () => {
  beforeEach(() => {
    useAppVersionStore.setState({
      upgradeRequired: false,
      currentVersion: null,
      updateUrl: null,
    });
  });

  it('starts with upgradeRequired as false', () => {
    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('does not expose otaInProgress state or a setOtaInProgress action', () => {
    const keys = Object.keys(useAppVersionStore.getState());

    expect(keys).not.toContain('otaInProgress');
    expect(keys).not.toContain('setOtaInProgress');
  });

  it('sets upgradeRequired to true', () => {
    useAppVersionStore.getState().setUpgradeRequired(true);

    expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
  });

  it('can be set back to false', () => {
    useAppVersionStore.getState().setUpgradeRequired(true);
    useAppVersionStore.getState().setUpgradeRequired(false);

    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('starts with currentVersion and updateUrl as null', () => {
    expect(useAppVersionStore.getState().currentVersion).toBeNull();
    expect(useAppVersionStore.getState().updateUrl).toBeNull();
  });

  it('stashes currentVersion and updateUrl from mismatch details', () => {
    useAppVersionStore.getState().setUpgradeRequired(true, {
      currentVersion: 'abc123',
      updateUrl: '/updates/download/ios/abc123',
    });

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBe('abc123');
    expect(state.updateUrl).toBe('/updates/download/ios/abc123');
  });

  it('coerces null/undefined detail fields to null', () => {
    // A 426 body with an explicit-null version and an omitted updateUrl exercises
    // the `?? null` fallbacks in both fields.
    useAppVersionStore.getState().setUpgradeRequired(true, { currentVersion: null });

    const state = useAppVersionStore.getState();
    expect(state.currentVersion).toBeNull();
    expect(state.updateUrl).toBeNull();
  });

  it('leaves currentVersion and updateUrl null when no details are provided', () => {
    useAppVersionStore.getState().setUpgradeRequired(true);

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBeNull();
    expect(state.updateUrl).toBeNull();
  });
});
