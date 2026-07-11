import { create } from 'zustand';

/** Version details carried by a 426 VERSION_MISMATCH response body. */
interface VersionMismatchDetails {
  currentVersion?: string | null;
  updateUrl?: string | null;
}

interface AppVersionState {
  upgradeRequired: boolean;
  // Server-reported values captured from a 426 VERSION_MISMATCH body: the
  // server's current version and, on mobile platforms, the OTA download URL.
  // Null until a 426 with a populated body lands — a bodyless/legacy 426 leaves
  // them null and only flips `upgradeRequired`.
  currentVersion: string | null;
  updateUrl: string | null;
  setUpgradeRequired: (required: boolean, details?: VersionMismatchDetails) => void;
  // True while the live-update flow is checking for / applying an OTA bundle.
  // Suppresses the upgrade-required modal during the version-mismatch window so
  // a transient 426 doesn't flash the modal before Capgo's silent reload lands.
  otaInProgress: boolean;
  setOtaInProgress: (inProgress: boolean) => void;
}

export const useAppVersionStore = create<AppVersionState>()((set) => ({
  upgradeRequired: false,
  currentVersion: null,
  updateUrl: null,

  setUpgradeRequired: (required, details) => {
    if (details === undefined) {
      set({ upgradeRequired: required });
      return;
    }
    set({
      upgradeRequired: required,
      currentVersion: details.currentVersion ?? null,
      updateUrl: details.updateUrl ?? null,
    });
  },

  otaInProgress: false,

  setOtaInProgress: (inProgress) => {
    set({ otaInProgress: inProgress });
  },
}));
