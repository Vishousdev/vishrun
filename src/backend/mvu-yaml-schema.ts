import jsYaml from 'js-yaml';

// YAML 1.2 core types plus merge keys: dates and times stay strings, like
// the `yaml` package MagVarUpdate uses. (That package itself is not bundled:
// its binary tag trips the host's backend capability scanner.)
export const YAML_SCHEMA = jsYaml.CORE_SCHEMA.extend([jsYaml.types.merge]);

export function yamlLoad(text: string): unknown {
  return jsYaml.load(text, { schema: YAML_SCHEMA });
}

export function yamlDump(value: unknown): string {
  return jsYaml.dump(value, { schema: YAML_SCHEMA, lineWidth: -1 });
}
