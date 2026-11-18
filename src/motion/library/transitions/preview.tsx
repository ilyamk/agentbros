import { registerRoot } from "remotion";
import { makeLibraryRoot } from "../Root";
import { items } from "./index";

registerRoot(makeLibraryRoot(items));
