// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2025  Philipp Emanuel Weidmann <pew@worldwidemann.com>

"use client";

import { Text } from "@radix-ui/themes";
import { current } from "immer";
import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import ErrorPopup from "@/components/ErrorPopup";
import MainMenu from "@/components/MainMenu";
import ProcessingOverlay from "@/components/ProcessingOverlay";
import StateDebugger from "@/components/StateDebugger";
import { abort, back, isAbortError, next } from "@/lib/engine";
import { sanitizeErrorMessage } from "@/lib/sanitize";
import { type Plugin, type PluginWrapper, useStateStore } from "@/lib/state";
import CharacterSelect from "@/views/CharacterSelect";
import Chat from "@/views/Chat";
import ConnectionSetup from "@/views/ConnectionSetup";
import GenreSelect from "@/views/GenreSelect";
import ScenarioSetup from "@/views/ScenarioSetup";
import Welcome from "@/views/Welcome";
import { Context } from "./plugins";
import type { Manifest } from "./plugins/route";

const TRUSTED_PLUGIN_NAMES: string[] = [];

function isValidPluginManifest(manifest: Manifest): boolean {
  if (!manifest.name || typeof manifest.name !== "string") return false;
  if (!manifest.main || typeof manifest.main !== "string") return false;
  if (manifest.main.includes("..") || manifest.main.includes("/") || manifest.main.includes("\\")) return false;
  if (!manifest.main.endsWith(".js")) return false;
  if (manifest.path.includes("..")) return false;
  return true;
}

export default function Home() {
  const [stateLoaded, setStateLoaded] = useState(false);
  const [pluginsLoaded, setPluginsLoaded] = useState(false);

  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayTitle, setOverlayTitle] = useState("Loading");
  const [overlayMessage, setOverlayMessage] = useState("Restoring state...");
  const [overlayTokenCount, setOverlayTokenCount] = useState(-1);
  const [onOverlayCancel, setOnOverlayCancel] = useState<(() => void) | undefined>(undefined);

  const [errorMessage, setErrorMessage] = useState("");
  const [onErrorRetry, setOnErrorRetry] = useState<(() => void) | undefined>(undefined);
  const [onErrorCancel, setOnErrorCancel] = useState<(() => void) | undefined>(undefined);

  const { view, setStateAsync } = useStateStore(
    useShallow((state) => ({
      view: state.view,
      setStateAsync: state.setAsync,
    })),
  );

  const [pendingPlugins, setPendingPlugins] = useState<Manifest[]>([]);
  const [pluginConfirmCallback, setPluginConfirmCallback] = useState<(() => void) | undefined>(undefined);
  const [pluginCancelCallback, setPluginCancelCallback] = useState<(() => void) | undefined>(undefined);

  const confirmPlugins = useCallback(async (manifests: Manifest[], stateRef: PluginWrapper[]): Promise<boolean> => {
    const untrusted: Manifest[] = [];
    for (const manifest of manifests) {
      if (!isValidPluginManifest(manifest)) continue;
      const isKnown = stateRef.some((p) => p.name === manifest.name) || TRUSTED_PLUGIN_NAMES.includes(manifest.name);
      if (!isKnown) {
        untrusted.push(manifest);
      }
    }

    if (untrusted.length > 0) {
      return new Promise<boolean>((resolve) => {
        setPendingPlugins(untrusted);
        setPluginConfirmCallback(() => () => {
          setPendingPlugins([]);
          setPluginConfirmCallback(undefined);
          setPluginCancelCallback(undefined);
          resolve(true);
        });
        setPluginCancelCallback(() => () => {
          setPendingPlugins([]);
          setPluginConfirmCallback(undefined);
          setPluginCancelCallback(undefined);
          resolve(false);
        });
      });
    }

    return true;
  }, []);

  const loadPlugins = async () => {
    setOverlayVisible(true);
    setOverlayTitle("Loading");
    setOverlayMessage("Loading plugin manifests...");
    setOverlayTokenCount(-1);
    setOnOverlayCancel(undefined);

    try {
      await setStateAsync(async (state) => {
        const response = await fetch("/plugins");
        const manifests: Manifest[] = await response.json();

        const validManifests = manifests.filter((m) => isValidPluginManifest(m));

        const shouldLoadPlugins = await confirmPlugins(validManifests, state.plugins);
        if (!shouldLoadPlugins) {
          return;
        }

        state.backends = {};

        outer: for (const manifest of validManifests) {
          let pluginWrapper: PluginWrapper | null = null;

          for (const plugin of state.plugins) {
            if (plugin.name === manifest.name) {
              if (!plugin.enabled) {
                // Don't load disabled plugins at all.
                continue outer;
              }

              pluginWrapper = plugin;
              break;
            }
          }

          setOverlayMessage(`Loading plugin "${manifest.name}"...`);

          const module = await import(/* webpackIgnore: true */ `/plugins/${manifest.path}/${manifest.main}`);
          const pluginClass = module.default;
          const plugin: Plugin = new pluginClass();

          if (plugin.init) {
            const context = new Context(manifest.name);
            await plugin.init(pluginWrapper ? current(pluginWrapper.settings) : manifest.settings, context);
          }

          if (plugin.getBackends) {
            Object.assign(state.backends, await plugin.getBackends());
          }

          if (pluginWrapper) {
            // Preserve settings for plugins loaded from state store;
            // only replace the plugin module itself.
            pluginWrapper.plugin = plugin;
          } else {
            // Plugin is new.
            state.plugins.push({
              name: manifest.name,
              enabled: true,
              settings: manifest.settings,
              plugin,
            });
          }
        }
      });

      setPluginsLoaded(true);
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!message) {
        message = "Unknown error";
      }
      setErrorMessage(sanitizeErrorMessage(message));
      setOnErrorRetry(() => () => {
        setErrorMessage("");
        loadPlugins();
      });
      setOnErrorCancel(undefined);
    } finally {
      setOverlayVisible(false);
    }
  };

  const nextView = async () => {
    try {
      await next(undefined, (title, message, tokenCount) => {
        setOverlayVisible(true);
        setOverlayTitle(title);
        setOverlayMessage(message);
        setOverlayTokenCount(tokenCount);
        setOnOverlayCancel(() => abort);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        let message = error instanceof Error ? error.message : String(error);
        if (!message) {
          message = "Unknown error";
        }
        setErrorMessage(sanitizeErrorMessage(message));
        setOnErrorRetry(() => () => {
          setErrorMessage("");
          nextView();
        });
        setOnErrorCancel(() => () => setErrorMessage(""));
      }
    } finally {
      setOverlayVisible(false);
    }
  };

  useEffect(() => {
    if (useStateStore.persist.hasHydrated()) {
      setStateLoaded(true);
    } else {
      const unsubscribe = useStateStore.persist.onFinishHydration(() => {
        setStateLoaded(true);
      });

      const timeout = setTimeout(() => {
        setStateLoaded(true);
      }, 5000);

      return () => {
        unsubscribe();
        clearTimeout(timeout);
      };
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: This should run only once.
  useEffect(() => {
    if (stateLoaded) {
      loadPlugins();
    }
  }, [stateLoaded]);

  return (
    <>
      {stateLoaded && pluginsLoaded && (
        <>
          {view === "welcome" && <Welcome onNext={nextView} />}
          {view === "connection" && <ConnectionSetup onNext={nextView} onBack={back} />}
          {view === "genre" && <GenreSelect onNext={nextView} onBack={back} />}
          {view === "character" && <CharacterSelect onNext={nextView} onBack={back} />}
          {view === "scenario" && <ScenarioSetup onNext={nextView} onBack={back} />}
          {view === "chat" && <Chat />}

          <MainMenu />
          <StateDebugger />
        </>
      )}

      {overlayVisible && (
        <ProcessingOverlay title={overlayTitle} onCancel={onOverlayCancel}>
          <Text as="div" size="6">
            {overlayMessage}
          </Text>
          {overlayTokenCount >= 0 && (
            <Text className="tabular-nums" as="div" size="4" color="lime">
              {overlayTokenCount > 0 ? `Tokens generated: ${overlayTokenCount}` : "Waiting for response..."}
            </Text>
          )}
        </ProcessingOverlay>
      )}

      {errorMessage && <ErrorPopup errorMessage={errorMessage} onRetry={onErrorRetry} onCancel={onErrorCancel} />}

      {pendingPlugins.length > 0 && pluginConfirmCallback && (
        <ErrorPopup
          errorMessage={`The following new plugins were detected and will execute code in your browser:\n\n${pendingPlugins.map((p) => `- ${p.name}`).join("\n")}\n\nOnly proceed if you trust the source of these plugins.`}
          onRetry={pluginConfirmCallback}
          onCancel={pluginCancelCallback}
        />
      )}
    </>
  );
}
