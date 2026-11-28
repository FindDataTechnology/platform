// 智语 tab's inner stack (openspec: add-zhiyu-mobile-clients 4.1): the list and
// one room, both under the tab so the tab stays selected while a room is open.
// Headers are off — each screen draws its own title row with the safe-area
// inset, the same way the chat tab does.

import { Stack } from "expo-router";

export default function ZhiyuLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
