import { defineStore } from 'pinia';
import { createControlState } from './control/state';
import { createAppLifecycleActions } from './control/app-lifecycle';
import { createSelectionContentActions } from './control/selection-content';
import { createKeysModelsActions } from './control/keys-models';
import { createRunsActions } from './control/runs';
import { createSyncActions } from './control/sync';
import { createAutoUpdateSettingsActions } from './control/auto-update-settings';
import { createPortableModeSettingsActions } from './control/portable-mode-settings';
import { createHideTraySettingsActions } from './control/hide-tray-settings';
import { useSelfUpdate } from '@/lib/useSelfUpdate';
import { api } from '@/lib/api';
import type { UpdateApplyResult, UpdateStatus } from '@/types';

export const useControlStore = defineStore('control', () => {
  const state = createControlState();
  // Shared self-update state machine (check/apply guards), see @/lib/useSelfUpdate.
  const selfUpdate = useSelfUpdate<UpdateStatus, UpdateApplyResult>(api);
  const selectionContentActions = createSelectionContentActions(state);
  const keysModelsActions = createKeysModelsActions(state);
  const runsActions = createRunsActions(state, {
    refreshKeys: keysModelsActions.refreshKeys,
  });
  // Created after runs so bootstrap can re-attach to whatever the server is still
  // running (the daemon outlives the tab, see runs.ts resumeRuns).
  const appLifecycleActions = createAppLifecycleActions(state, {
    checkForUpdate: selfUpdate.checkForUpdate,
    resumeRuns: runsActions.resumeRuns,
  });
  // "Sync my settings with Connections" (opt-in cloud sync of theme), see @/stores/control/sync.
  const syncActions = createSyncActions();
  // Silent auto-update opt-in, see @/stores/control/auto-update-settings.
  const autoUpdateSettingsActions = createAutoUpdateSettingsActions();
  // Portable window opt-in, see @/stores/control/portable-mode-settings.
  const portableModeSettingsActions = createPortableModeSettingsActions();
  // Hide-tray-icon opt-in, see @/stores/control/hide-tray-settings.
  const hideTraySettingsActions = createHideTraySettingsActions();

  return {
    // data
    inputs: state.inputs,
    models: state.models,
    archivedModels: state.archivedModels,
    prompts: state.prompts,
    references: state.references,
    keys: state.keys,
    runs: state.runs,
    deletingRunIds: state.deletingRunIds,
    sessionInputIds: state.sessionInputIds,
    spend: state.spend,
    costEstimate: state.costEstimate,
    costEstimateLoading: state.costEstimateLoading,
    providerDefaults: state.providerDefaults,
    updateStatus: selfUpdate.updateStatus,
    updateChecking: selfUpdate.updateChecking,
    updateApplying: selfUpdate.updateApplying,
    // selection/options
    selInputs: state.selInputs,
    selModels: state.selModels,
    selPrompts: state.selPrompts,
    selReference: state.selReference,
    referenceOn: state.referenceOn,
    mock: state.mock,
    modelQty: state.modelQty,
    maxImages: state.maxImages,
    customOn: state.customOn,
    custom: state.custom,
    advancedOpen: state.advancedOpen,
    refNote: state.refNote,
    brandOn: state.brandOn,
    brandStyleGuide: state.brandStyleGuide,
    brandStyleGuideDefault: state.brandStyleGuideDefault,
    brandAttachments: state.brandAttachments,
    // run progress (single-run views of the focused run, plus the queue behind it)
    runId: state.runId,
    runTitle: state.runTitle,
    runStatus: state.runStatus,
    queuePosition: state.queuePosition,
    total: state.total,
    running: state.running,
    submitting: state.submitting,
    jobList: state.jobList,
    activeRuns: state.activeRuns,
    backlogRuns: state.backlogRuns,
    anyRunActive: state.anyRunActive,
    // live check
    liveCheckArmed: state.liveCheckArmed,
    liveCheckBusy: state.liveCheckBusy,
    // settings sync
    syncStatus: syncActions.syncStatus,
    syncLoading: syncActions.syncLoading,
    syncActionBusy: syncActions.syncActionBusy,
    // auto-update opt-in
    autoUpdateEnabled: autoUpdateSettingsActions.autoUpdateEnabled,
    autoUpdateLoading: autoUpdateSettingsActions.autoUpdateLoading,
    // portable window opt-in
    portableModeEnabled: portableModeSettingsActions.portableModeEnabled,
    portableModeLoading: portableModeSettingsActions.portableModeLoading,
    // hide tray icon opt-in
    hideTrayIconEnabled: hideTraySettingsActions.hideTrayIconEnabled,
    hideTrayIconLoading: hideTraySettingsActions.hideTrayIconLoading,
    // getters
    runnableModels: state.runnableModels,
    runnableModelIds: state.runnableModelIds,
    envNote: state.envNote,
    estimate: state.estimate,
    progress: state.progress,
    // actions
    bootstrap: appLifecycleActions.bootstrap,
    checkForUpdate: selfUpdate.checkForUpdate,
    applyUpdate: selfUpdate.applyUpdate,
    recordPulse: appLifecycleActions.recordPulse,
    toggleInput: selectionContentActions.toggleInput,
    toggleModel: selectionContentActions.toggleModel,
    setModelQty: selectionContentActions.setModelQty,
    togglePrompt: selectionContentActions.togglePrompt,
    toggleReference: selectionContentActions.toggleReference,
    selectAll: selectionContentActions.selectAll,
    selectNone: selectionContentActions.selectNone,
    uploadFiles: selectionContentActions.uploadFiles,
    uploadReferences: selectionContentActions.uploadReferences,
    addBrandAttachments: selectionContentActions.addBrandAttachments,
    removeBrandAttachment: selectionContentActions.removeBrandAttachment,
    saveBrandStyleGuideDefault: selectionContentActions.saveBrandStyleGuideDefault,
    clearBrandStyleGuideDefault: selectionContentActions.clearBrandStyleGuideDefault,
    deleteInput: selectionContentActions.deleteInput,
    savePrompt: selectionContentActions.savePrompt,
    deletePrompt: selectionContentActions.deletePrompt,
    restoreDefaultPrompts: selectionContentActions.restoreDefaultPrompts,
    togglePromptStarred: selectionContentActions.togglePromptStarred,
    shutdownServer: appLifecycleActions.shutdownServer,
    refreshRuns: runsActions.refreshRuns,
    deleteRuns: runsActions.deleteRuns,
    refreshKeys: keysModelsActions.refreshKeys,
    saveKey: keysModelsActions.saveKey,
    deleteKey: keysModelsActions.deleteKey,
    importKeys: keysModelsActions.importKeys,
    saveModel: keysModelsActions.saveModel,
    toggleModelStarred: keysModelsActions.toggleModelStarred,
    deleteModel: keysModelsActions.deleteModel,
    restoreModel: keysModelsActions.restoreModel,
    reorderModels: keysModelsActions.reorderModels,
    liveCheck: keysModelsActions.liveCheck,
    cancelLiveCheck: keysModelsActions.cancelLiveCheck,
    resetLiveCheck: keysModelsActions.resetLiveCheck,
    startRun: runsActions.startRun,
    cancelRun: runsActions.cancelRun,
    focusRun: runsActions.focusRun,
    refreshCostEstimate: runsActions.refreshCostEstimate,
    loadSyncStatus: syncActions.loadSyncStatus,
    enableSync: syncActions.enableSync,
    disableSync: syncActions.disableSync,
    pullSync: syncActions.pullSync,
    pushSync: syncActions.pushSync,
    pushAppearance: syncActions.pushAppearance,
    applyAppearance: syncActions.applyAppearance,
    loadAutoUpdateSetting: autoUpdateSettingsActions.loadAutoUpdateSetting,
    setAutoUpdate: autoUpdateSettingsActions.setAutoUpdate,
    loadPortableModeSetting: portableModeSettingsActions.loadPortableModeSetting,
    setPortableMode: portableModeSettingsActions.setPortableMode,
    loadHideTrayIconSetting: hideTraySettingsActions.loadHideTrayIconSetting,
    setHideTrayIcon: hideTraySettingsActions.setHideTrayIcon,
  };
});
