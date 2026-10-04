// Unit conversions: what the interface shows and reads back in US units.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromShown, toShown, unitLabel } from "../src/units.ts";

const close = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test("US units match their definitions", () => {
  close(toShown(25.4, "mm", "us"), 1);
  close(toShown(4.4482216152605, "N", "us"), 1);
  close(toShown(6.894757293, "MPa", "us"), 1000);
  close(toShown(27679.9047, "kg/m³", "us"), 1);
  close(toShown(0.45359237, "kg", "us"), 1);
  close(toShown(9.80665, "m/s²", "us"), 386.0886, 1e-6);
  close(toShown(1.730735, "W/(m·K)", "us"), 1);
  // Temperatures are absolute: offset as well as scale.
  close(toShown(20, "°C", "us"), 68);
  close(toShown(100, "°C", "us"), 212);
  close(toShown(-40, "°C", "us"), -40);
  // Per-degree quantities scale only.
  close(toShown(18, "µm/(m·°C)", "us"), 10);
  assert.equal(unitLabel("MPa", "us"), "psi");
  assert.equal(unitLabel("MPa", "si"), "MPa");
});

test("shown values convert back exactly, and shared units pass through", () => {
  for (const unit of [
    "mm",
    "mm²",
    "mm³",
    "N",
    "N·mm",
    "MPa",
    "MPa per mm",
    "kg/m³",
    "kg",
    "°C",
    "m/s²",
    "W/(m·K)",
    "µm/(m·°C)",
    "W/(m²·K)",
    "W/m²",
    "µm/m",
  ])
    close(fromShown(toShown(123.456, unit, "us"), unit, "us"), 123.456, 1e-12);
  for (const unit of ["Hz", "%", "rpm", "W", "relative"]) {
    assert.equal(toShown(5, unit, "us"), 5);
    assert.equal(unitLabel(unit, "us"), unit);
  }
  assert.equal(toShown(5, "mm", "si"), 5);
});
