import { IS_DEV } from '@config-web';
import useSettings from '@hooks/useSettings';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

function useDiscordActivity(options = { description: null, actionIcon: null, actionTitle: null }) {
  const { t } = useTranslation();
  const { description = null, actionIcon = null, actionTitle = null } = options;
  const { settings } = useSettings();
  const isLoaded = !!settings;
  const enabled = settings?.DISCORD_ENABLED === true;

  useEffect(() => {
    if (IS_DEV || !isLoaded) {
      return;
    }

    // When off, only the "off" signal is sent: it clears the Discord status and disconnects
    window.EA(
      'DISCORD_ACTIVITY',
      enabled
        ? {
            enabled,
            description: description || null,
            actionIcon: actionIcon || null,
            actionTitle: actionTitle || null,
            applicationTitle: t('Free Stop Motion Software'),
          }
        : { enabled: false }
    );
  }, [isLoaded, enabled, description, actionIcon, actionTitle, t]);

  return null;
}

export default useDiscordActivity;
