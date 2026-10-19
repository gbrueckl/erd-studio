# Glossary

ERD Studio's screens now say **table**, **Table Library** and **subject area**. Older releases said *model*, *Model Library* and *domain*, and the files on disk and the code still use those older names for now. Renaming the on-disk names is planned for a later release (#162 part 4). Until then, every file written today keeps loading.

This page matches each word on screen to the name you'll find in the files and in the code.

| On screen | On disk today | In the code | Meaning |
|---|---|---|---|
| **Table** | One YAML file in `.erd-studio/logical-models/` (`logical-models/{name}.yml`, or one folder down) | `SemanticModel` (core types), `DisplayModel` (what the canvas draws), `ModelNode` (the canvas node) | One table in your design: its columns, keys, grain and rationale. Its `name` is its identity everywhere. |
| **Table Library** | The `.erd-studio/logical-models/` folder | `LogicalModelService`, `ModelLibraryTreeProvider` (view id `erdStudio.modelLibrary`) | Every table in the project, each stored once and shared by every subject area that uses it. |
| **Subject Area** | One JSON file, `.erd-studio/{layer}/{name}.json`, with a `domain` field naming it. Its tables are listed in `logical.models` | `SemanticDomain` / `UnifiedDomain` (the file as read), `DisplayDomain` (one stage, ready to draw), `DomainService` | One area of the business (sales, finance…): the tables it shows, its layout and, in older projects, its relationships. |
| **The data model** | Everything under `.erd-studio/` | — | All of it together: every subject area, every table and the relationships between them. |
| **dbt model** (meaning unchanged) | dbt's own files: `.sql` / `.py` under `models/`, schema `.yml`, `target/manifest.json` | `ManifestService`, `YmlParserService`, `CatalogService` | A model in your dbt project. **Draw from dbt** and **Add Tables from dbt** turn dbt models into tables. |
| **Diagram / canvas** | The `viewConfig` section of the subject area file (positions, notes) | `ErdCanvas` (`@erd-studio/renderer`), `SemanticEditorProvider` (the VS Code editor) | The picture of one subject area that you edit. |
| **Layer** | `.erd-studio/layers.json`; the `{layer}` folder a subject area file sits in, and the `layer` field | `Layer`, `LayerConfig`, `LayerService` | A stage of your warehouse (bronze, silver, gold). Optionally also a folder in the Table Library. |
| **Logical stage** | The table YAMLs plus the subject area file's `logical` section | `Stage` = `'logical'`, `buildLogicalDisplayDomain` | Your design, in blue. The stage you edit. |
| **Physical stage** | Nothing: it is never saved | `Stage` = `'physical'`, `DomainService.buildPhysicalDomain` | What your dbt project has, in green, read from dbt every time. Read-only. |
| **Relationship** | A `relationships:` entry in the table YAML that holds the foreign key (no `fromModel`, since that is the file's own table), or a `logical.relationships` entry with `fromModel` / `toModel` in a subject area file | `Relationship`, `DisplayRelationship` | A line between two tables, from the foreign key to the key it points at. |

Other on-disk names that keep the old word: `modelRole` (the table's role, such as `conformed-dim`), `modelFolder`, `linkedModel` on a note, and the `--domain` and `--models` options of the `erd-studio` command-line helper.

## Command and setting ids

Only the words on screen changed. The ids of commands, settings and views keep their old names, so your keybindings, `settings.json` and `when` clauses keep working. For example, **ERD Studio: New Subject Area** is still the command `erdStudio.createDomain`, and the folder setting is still `erdStudio.semanticDir`.

For the file formats in full, see the [file format reference](semantic-domain-json-reference.md).
