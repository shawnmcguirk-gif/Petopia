-- =============================================================
-- Petopia DB -- 013: the Timeline view carries where a fact came from (D1 spec sec 4.4, 5; slice S5; A21).
-- Same view as 010 with two columns added at the end (CREATE OR REPLACE VIEW may only append): source_document_id and
-- source_page, so an entry read from a document links back to its original and page. Idempotent.
-- =============================================================
CREATE OR REPLACE VIEW timeline.entry_v AS
  SELECT v.workspace_id, v.animal_id, v.visit_on AS on_date, v.visit_precision AS precision, 'HEALTH'::text AS category,
         'VET_VISIT'::text AS kind, coalesce(v.reason, initcap(replace(v.kind, '_', ' '))) AS title,
         nullif(concat_ws(' · ', v.diagnosis_text, v.vet_name), '') AS detail,
         v.source_class, v.status, v.channel, 'vet_visit'::text AS ref_table, v.vet_visit_id AS ref_id, v.created_at, v.source_document_id, v.source_page
    FROM health.vet_visit v WHERE v.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, x.given_on, x.given_precision, 'HEALTH', 'VACCINATION', x.vaccine,
         CASE WHEN x.next_due_on IS NOT NULL THEN 'next due ' || to_char(x.next_due_on, 'YYYY-MM-DD') END,
         x.source_class, x.status, x.channel, 'vaccination', x.vaccination_id, x.created_at, x.source_document_id, x.source_page
    FROM health.vaccination x WHERE x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, x.given_on, x.given_precision, 'HEALTH', 'TREATMENT_' || x.kind, coalesce(x.product, initcap(x.kind)),
         CASE WHEN x.next_due_on IS NOT NULL THEN 'next due ' || to_char(x.next_due_on, 'YYYY-MM-DD') END,
         x.source_class, x.status, x.channel, 'treatment', x.treatment_id, x.created_at, x.source_document_id, x.source_page
    FROM health.treatment x WHERE x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, coalesce(x.first_noted_on, x.created_at::date), coalesce(x.first_noted_precision, 'DAY'), 'HEALTH',
         'CONDITION', x.name, lower(x.condition_status), x.source_class, x.status, x.channel, 'condition', x.condition_id, x.created_at, x.source_document_id, x.source_page
    FROM health.condition x WHERE x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, coalesce(x.noted_on, x.created_at::date), coalesce(x.noted_precision, 'DAY'), 'HEALTH',
         'ALLERGY', x.substance, x.reaction, x.source_class, x.status, x.channel, 'allergy', x.allergy_id, x.created_at, x.source_document_id, x.source_page
    FROM health.allergy x WHERE x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, x.performed_on, x.performed_precision, 'HEALTH', 'PROCEDURE', x.name, x.outcome,
         x.source_class, x.status, x.channel, 'procedure', x.procedure_id, x.created_at, x.source_document_id, x.source_page
    FROM health.procedure x WHERE x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, x.sampled_on, x.sampled_precision, 'HEALTH', 'LAB_RESULT',
         x.test || coalesce(': ' || x.analyte, ''),
         nullif(concat_ws(' ', x.value_printed, x.unit_printed, '(' || x.flag_printed || ')'), ''),
         x.source_class, x.status, x.channel, 'lab_result', x.lab_result_id, x.created_at, x.source_document_id, x.source_page
    FROM health.lab_result x WHERE x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT e.workspace_id, e.animal_id, e.event_on, e.event_precision, 'HEALTH', 'MEDICATION_' || e.event_kind, m.product_name,
         nullif(concat_ws(' · ', e.dose_text, e.frequency), ''),
         e.source_class, e.status, e.channel, 'medication_event', e.medication_event_id, e.created_at, e.source_document_id, e.source_page
    FROM health.medication_event e
    JOIN health.medication m ON m.workspace_id = e.workspace_id AND m.medication_id = e.medication_id
   WHERE e.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, (x.observed_at AT TIME ZONE 'Europe/Dublin')::date, 'DAY',
         CASE WHEN x.measure = 'weight' THEN 'WEIGHT' ELSE 'HEALTH' END, 'MEASUREMENT_' || upper(x.measure),
         trim(to_char(x.value, 'FM999999990.999'), '.') || ' ' || x.unit, x.note,
         x.source_class, x.status, x.channel, 'measurement', x.measurement_id, x.created_at, x.source_document_id, x.source_page
    FROM health.measurement x WHERE x.animal_id IS NOT NULL AND x.status IN ('CONFIRMED','PROPOSED')
  UNION ALL
  SELECT x.workspace_id, x.animal_id, x.from_on, 'DAY', 'FOOD', 'FOOD_STARTED', concat_ws(' ', x.brand, x.product), x.objective,
         x.source_class, x.status, x.channel, 'feeding_plan', x.feeding_plan_id, x.created_at, x.source_document_id, x.source_page
    FROM diet.feeding_plan x WHERE x.status IN ('CONFIRMED','PROPOSED');
