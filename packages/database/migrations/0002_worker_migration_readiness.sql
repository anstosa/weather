-- allow worker startup and health to verify known migration checksums
GRANT SELECT ON schema_migrations TO weather_ingest;
