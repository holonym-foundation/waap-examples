import React, { useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";

import type { RunEntry, RunLog } from "../workbench/runLog";

export function Screen({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.screen}>
      <Text selectable style={styles.title}>
        {title}
      </Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {children}
    </View>
  );
}

/**
 * Every action goes through the log, so a rejection is shown, not thrown. The
 * last result also shows under the button that produced it.
 */
export function Action({
  label,
  log,
  disabled,
  primary,
  run,
}: {
  label: string;
  log: RunLog;
  disabled?: boolean;
  primary?: boolean;
  run: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunEntry | null>(null);
  const style: ViewStyle[] = [styles.button];
  if (primary) style.push(styles.primary);
  if (disabled || busy) style.push(styles.disabled);

  const press = async () => {
    setBusy(true);
    setResult(null);
    setResult(await log.run(label, run));
    setBusy(false);
  };

  return (
    <View style={styles.action}>
      <TouchableOpacity
        accessibilityRole="button"
        disabled={disabled || busy}
        style={style}
        onPress={() => void press()}
      >
        <Text style={primary ? styles.primaryText : styles.buttonText}>
          {busy ? `${label}…` : label}
        </Text>
      </TouchableOpacity>
      {result ? (
        <Text selectable style={result.ok ? styles.ok : styles.failed}>
          {result.ok ? "✓ " : "✕ "}
          {result.detail}
        </Text>
      ) : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { padding: 16, gap: 10 },
  action: { gap: 4 },
  ok: { fontFamily: "Menlo", fontSize: 11, color: "#15803d" },
  failed: { fontFamily: "Menlo", fontSize: 11, color: "#b91c1c" },
  title: { fontSize: 16, fontWeight: "600", color: "#111827" },
  note: { fontSize: 13, color: "#4b5563" },
  button: {
    borderWidth: 1,
    borderColor: "#4f46e5",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  primary: { backgroundColor: "#4f46e5" },
  disabled: { opacity: 0.4 },
  buttonText: { color: "#4f46e5", fontWeight: "600" },
  primaryText: { color: "#ffffff", fontWeight: "600" },
});
