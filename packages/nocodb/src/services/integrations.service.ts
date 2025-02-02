import { Injectable } from '@nestjs/common';
import { AppEvents } from 'nocodb-sdk';
import type { IntegrationReqType, IntegrationsType } from 'nocodb-sdk';
import type { NcContext, NcRequest } from '~/interface/config';
import { AppHooksService } from '~/services/app-hooks/app-hooks.service';
import { validatePayload } from '~/helpers';
import { Base, Integration } from '~/models';
import { NcError } from '~/helpers/catchError';
import { Source } from '~/models';
import { CacheScope, MetaTable, RootScopes } from '~/utils/globals';
import Noco from '~/Noco';
import NocoCache from '~/cache/NocoCache';
import NcConnectionMgrv2 from '~/utils/common/NcConnectionMgrv2';
import { JobsRedis } from '~/modules/jobs/redis/jobs-redis';
import { InstanceCommands } from '~/interface/Jobs';
import { SourcesService } from '~/services/sources.service';

@Injectable()
export class IntegrationsService {
  constructor(
    protected readonly appHooksService: AppHooksService,
    protected readonly sourcesService: SourcesService,
  ) {}

  async integrationGetWithConfig(
    context: NcContext,
    param: { integrationId: any; includeSources?: boolean },
  ) {
    const integration = await Integration.get(context, param.integrationId);

    integration.config = await integration.getConnectionConfig();

    if (param.includeSources) {
      await integration.getSources();
    }

    return integration;
  }

  async integrationUpdate(
    context: NcContext,
    param: {
      integrationId: string;
      integration: IntegrationReqType;
      req: NcRequest;
    },
  ) {
    validatePayload(
      'swagger.json#/components/schemas/IntegrationReq',
      param.integration,
    );

    const integrationBody = param.integration;
    const integration = await Integration.updateIntegration(
      context,
      param.integrationId,
      {
        ...integrationBody,
        id: param.integrationId,
      },
    );

    // update the cache for the sources which are using this integration
    await this.updateIntegrationSourceConfig({ integration });

    integration.config = undefined;

    this.appHooksService.emit(AppEvents.INTEGRATION_UPDATE, {
      integration,
      req: param.req,
      user: param.req?.user,
    });

    return integration;
  }

  async integrationList(param: {
    req: NcRequest;
    includeDatabaseInfo: boolean;
    type?: IntegrationsType;
    limit?: number;
    offset?: number;
    query?: string;
  }) {
    const integrations = await Integration.list({
      userId: param.req.user?.id,
      includeDatabaseInfo: param.includeDatabaseInfo,
      type: param.type,
      limit: param.limit,
      offset: param.offset,
      includeSourceCount: true,
      query: param.query,
    });

    return integrations;
  }

  async integrationDelete(
    context: Omit<NcContext, 'base_id'>,
    param: { integrationId: string; req: any; force: boolean },
  ) {
    const ncMeta = await Noco.ncMeta.startTransaction();
    try {
      const integration = await Integration.get(
        context,
        param.integrationId,
        true,
        ncMeta,
      );

      // check linked sources
      const sources = await ncMeta.metaList2(
        RootScopes.WORKSPACE,
        RootScopes.WORKSPACE,
        MetaTable.BASES,
        {
          condition: {
            fk_workspace_id: integration.fk_workspace_id,
            fk_integration_id: integration.id,
          },
          xcCondition: {
            _or: [
              {
                deleted: {
                  eq: false,
                },
              },
              {
                deleted: {
                  eq: null,
                },
              },
            ],
          },
        },
      );

      if (sources.length > 0 && !param.force) {
        const bases = await Promise.all(
          sources.map(async (source) => {
            return await Base.get(
              {
                workspace_id: integration.fk_workspace_id,
                base_id: source.base_id,
              },
              source.base_id,
              ncMeta,
            );
          }),
        );

        NcError.integrationLinkedWithMultiple(bases, sources);
      }

      for (const source of sources) {
        await this.sourcesService.baseDelete(
          {
            workspace_id: integration.fk_workspace_id,
            base_id: source.base_id,
          },
          {
            sourceId: source.id,
            req: param.req,
          },
          ncMeta,
        );
      }

      await integration.delete(ncMeta);
      this.appHooksService.emit(AppEvents.INTEGRATION_DELETE, {
        integration,
        req: param.req,
        user: param.req?.user,
      });

      await ncMeta.commit();
    } catch (e) {
      await ncMeta.rollback(e);
      NcError.badRequest(e);
    }
    return true;
  }

  async integrationSoftDelete(
    context: Omit<NcContext, 'base_id'>,
    param: { integrationId: string },
  ) {
    try {
      const integration = await Integration.get(context, param.integrationId);
      await integration.softDelete();
    } catch (e) {
      NcError.badRequest(e);
    }
    return true;
  }

  async integrationCreate(
    context: NcContext,
    param: {
      integration: IntegrationReqType;
      logger?: (message: string) => void;
      req: any;
    },
  ) {
    validatePayload(
      'swagger.json#/components/schemas/IntegrationReq',
      param.integration,
    );

    let integrationBody;

    if (param.integration.copy_from_id) {
      integrationBody = await Integration.get(
        context,
        param.integration.copy_from_id,
      );

      if (!integrationBody?.id) {
        NcError.integrationNotFound(param.integration.copy_from_id);
      }

      integrationBody.config = await integrationBody.getConnectionConfig();
    } else {
      integrationBody = param.integration;
    }
    param.logger?.('Creating the integration');

    const integration = await Integration.createIntegration({
      ...integrationBody,
      ...(param.integration.copy_from_id
        ? { title: `${integrationBody.title}_copy` }
        : {}),
      created_by: param.req.user.id,
    });

    integration.config = undefined;

    this.appHooksService.emit(AppEvents.INTEGRATION_CREATE, {
      integration,
      req: param.req,
      user: param.req?.user,
    });

    return integration;
  }

  // function to update all the integration source config which are using this integration
  // we are overwriting the source config with the new integration config excluding database name and schema name
  private async updateIntegrationSourceConfig(
    {
      integration,
    }: {
      integration: Integration;
    },
    ncMeta = Noco.ncMeta,
  ) {
    // get all the bases which are using this integration
    const sources = await ncMeta.metaList2(
      integration.fk_workspace_id,
      RootScopes.WORKSPACE,
      MetaTable.BASES,
      {
        condition: {
          fk_integration_id: integration.id,
        },
        xcCondition: {
          _or: [
            {
              deleted: {
                eq: false,
              },
            },
            {
              deleted: {
                eq: null,
              },
            },
          ],
        },
      },
    );

    // iterate and update the cache for the sources
    for (const sourceObj of sources) {
      const source = new Source(sourceObj);

      // update the cache with the new config(encrypted)
      await NocoCache.update(`${CacheScope.BASE}:${source.id}`, {
        integration_config: integration.config,
      });

      // delete the connection ref
      await NcConnectionMgrv2.deleteAwait(source);

      // release the connections from the worker
      if (JobsRedis.available) {
        await JobsRedis.emitWorkerCommand(InstanceCommands.RELEASE, source.id);
        await JobsRedis.emitPrimaryCommand(InstanceCommands.RELEASE, source.id);
      }
    }
  }
}
