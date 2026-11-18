import { registerRoot } from "remotion";
import { items as backgrounds } from "../backgrounds";
import { makeLibraryRoot } from "../Root";
import { items as finish } from "./index";

registerRoot(makeLibraryRoot([...finish, ...backgrounds]));
