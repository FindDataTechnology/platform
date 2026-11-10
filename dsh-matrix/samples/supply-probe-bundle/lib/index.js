// @platform/supply-probe-bundle — an inert dsh bundle that proves the
// platform's plugin-supply chain end-to-end: matrix bake (dsh-matrix file:
// dependency) → template bundle declaration → profile composition →
// `plugins/list` roster row → persisted enable/disable toggle.
//
// Activation deliberately does nothing: the sample exists to exercise the
// supply plumbing, never to carry behavior. A real whitelisted bundle exports
// its own plugin surface here (services, tools, prompt sections).

export const name = "supply-probe";

export function apply() {}