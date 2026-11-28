// Fleet state → badge tone. One definition for the cockpit rail, the overview
// and the management table (the table used to print the raw server value).
export const STATE_STYLES: Record<string, string> = {
  active: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
  archived: "bg-muted text-muted-foreground",
};
