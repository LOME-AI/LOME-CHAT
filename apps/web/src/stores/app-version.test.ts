import { describe, it, expect, beforeEach } from 'vitest';
import { useAppVersionStore } from './app-version';

describe('useAppVersionStore', () => {
  beforeEach(() => {
    useAppVersionStore.setState({
      upgradeRequired: false,
      otaInProgress: false,
      currentVersion: null,
      updateUrl: null,
    });
  });

  it('starts with upgradeRequired as false', () => {
    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });

  it('starts with otaInProgress as false', () => {
    expect(useAppVersionStore.getState().otaInProgress).toBe(false);
  });

  it('sets otaInProgress to true', () => {
    useAppVersionStore.getState().setOtaInProgress(true);

    expect(useAppVersionStore.getState().otaInProgress).toBe(true);
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

  it('leaves currentVersion and updateUrl null when no details are provided', () => {
    useAppVersionStore.getState().setUpgradeRequired(true);

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBeNull();
    expect(state.updateUrl).toBeNull();
  });
});
