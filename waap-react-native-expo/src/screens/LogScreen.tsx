import React, { useSyncExternalStore } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import type { RunLog } from "../workbench/runLog";

export function LogScreen({ log }: { log: RunLog }) {
  const entries = useSyncExternalStore(log.subscribe, log.entries);
  return (
    <View style={styles.screen}>
      <TouchableOpacity accessibilityRole="button" onPress={log.clear}>
        <Text style={styles.clear}>Clear</Text>
      </TouchableOpacity>
      {entries.map((entry) => (
        <View key={entry.id} style={styles.entry}>
          <Text style={entry.ok ? styles.ok : styles.failed}>
            {entry.ok ? "✓" : "✕"} {entry.label}
          </Text>
          <Text selectable style={styles.detail}>
            {entry.detail}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 12 },
  clear: { alignSelf: "flex-end", color: "#4f46e5", fontWeight: "600" },
  entry: { gap: 2 },
  ok: { color: "#15803d", fontWeight: "600" },
  failed: { color: "#b91c1c", fontWeight: "600" },
  detail: { fontFamily: "Menlo", fontSize: 12, color: "#374151" },
});
