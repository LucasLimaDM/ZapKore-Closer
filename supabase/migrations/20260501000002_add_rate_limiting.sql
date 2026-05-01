-- Rate limit settings on user_integrations (per operator)
ALTER TABLE public.user_integrations
  ADD COLUMN IF NOT EXISTS rate_limit_enabled        BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS rate_limit_msg_per_hour   INTEGER   NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS rate_limit_tokens_per_day INTEGER   NOT NULL DEFAULT 2000000,
  ADD COLUMN IF NOT EXISTS rate_limit_message        TEXT      NOT NULL DEFAULT 'Identificamos um volume elevado de mensagens e transferiremos seu atendimento para um de nossos atendentes. Em breve você será atendido!';

-- Rolling-window counters on whatsapp_contacts (per contact)
ALTER TABLE public.whatsapp_contacts
  ADD COLUMN IF NOT EXISTS msg_count_hour   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS msg_window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS token_count_day  BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_day_start  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- RPC: increment msg counter, reset window if expired, return new count
CREATE OR REPLACE FUNCTION public.increment_contact_msg(
  p_contact_id  UUID,
  p_window_secs INT DEFAULT 3600
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE public.whatsapp_contacts
  SET
    msg_count_hour   = CASE
                         WHEN EXTRACT(EPOCH FROM (NOW() - msg_window_start)) > p_window_secs
                         THEN 1
                         ELSE msg_count_hour + 1
                       END,
    msg_window_start = CASE
                         WHEN EXTRACT(EPOCH FROM (NOW() - msg_window_start)) > p_window_secs
                         THEN NOW()
                         ELSE msg_window_start
                       END
  WHERE id = p_contact_id
  RETURNING msg_count_hour INTO v_new_count;

  RETURN COALESCE(v_new_count, 0);
END;
$$;

-- RPC: add tokens to daily counter, reset window if expired, return new total
CREATE OR REPLACE FUNCTION public.add_contact_tokens(
  p_contact_id  UUID,
  p_tokens      INT,
  p_window_secs INT DEFAULT 86400
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_total BIGINT;
BEGIN
  UPDATE public.whatsapp_contacts
  SET
    token_count_day = CASE
                        WHEN EXTRACT(EPOCH FROM (NOW() - token_day_start)) > p_window_secs
                        THEN p_tokens
                        ELSE token_count_day + p_tokens
                      END,
    token_day_start = CASE
                        WHEN EXTRACT(EPOCH FROM (NOW() - token_day_start)) > p_window_secs
                        THEN NOW()
                        ELSE token_day_start
                      END
  WHERE id = p_contact_id
  RETURNING token_count_day INTO v_new_total;

  RETURN COALESCE(v_new_total, 0);
END;
$$;
