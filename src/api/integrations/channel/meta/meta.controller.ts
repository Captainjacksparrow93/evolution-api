import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data.object === 'whatsapp_business_account') {
      if (data.entry[0]?.changes[0]?.field === 'message_template_status_update') {
        const template = await this.prismaRepository.template.findFirst({
          where: { templateId: `${data.entry[0].changes[0].value.message_template_id}` },
        });

        if (!template) {
          console.log('template not found');
          return;
        }

        const { webhookUrl } = template;

        await axios.post(webhookUrl, data.entry[0].changes[0].value, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        return;
      }

      // Awaited on purpose: an unawaited async callback lets this handler
      // return before the entries are processed, and a serverless runtime
      // freezes the invocation the moment the response is sent — dropping the
      // message writes and outbound webhooks still in flight.
      await Promise.all(
        (data.entry ?? []).map(async (entry: any) => {
          const numberId = entry.changes[0].value.metadata.phone_number_id;

          if (!numberId) {
            this.logger.error('WebhookService -> receiveWebhookMeta -> numberId not found');
            return;
          }

          const instance = await this.prismaRepository.instance.findFirst({
            where: { number: numberId },
          });

          if (!instance) {
            this.logger.error('WebhookService -> receiveWebhookMeta -> instance not found');
            return;
          }

          const waInstance = await this.waMonitor.getInstance(instance.name);

          if (!waInstance) {
            this.logger.error(`WebhookService -> receiveWebhookMeta -> could not load instance "${instance.name}"`);
            return;
          }

          await waInstance.connectToWhatsapp(data);
        }),
      );
    }

    return {
      status: 'success',
    };
  }
}
