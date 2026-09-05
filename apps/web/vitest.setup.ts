import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { installGlobalLeakGuard } from "./app/test-tools/global-leak-guard";

installGlobalLeakGuard(cleanup);
