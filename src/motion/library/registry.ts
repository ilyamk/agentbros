import { items as backgrounds } from "./backgrounds";
import { items as camera } from "./camera";
import { items as captions } from "./captions";
import { items as data } from "./data";
import { items as effects } from "./effects";
import { items as finish } from "./finish";
import { items as kinetic } from "./kinetic";
import { items as scenes } from "./scenes";
import { styles } from "./styles";
import { items as three } from "./three";
import { items as transitions } from "./transitions";
import { items as typography } from "./typography";
import type { LibraryItem } from "./types";
import { items as ui } from "./ui";

export const libraryItems: LibraryItem[] = [
  ...typography,
  ...finish,
  ...backgrounds,
  ...ui,
  ...transitions,
  ...camera,
  ...three,
  ...data,
  ...scenes,
  ...kinetic,
  ...effects,
  ...captions,
];

export const libraryStyles = styles;
