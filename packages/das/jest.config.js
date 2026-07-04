/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testRegex: ".*\\.spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  // NestJS decorators (and TypeORM entities pulled in transitively by some
  // units under test) need the metadata reflection polyfill at load time.
  setupFiles: ["reflect-metadata"],
};
