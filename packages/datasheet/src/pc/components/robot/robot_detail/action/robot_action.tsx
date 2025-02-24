/**
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import axios from 'axios';
import cx from 'classnames';
import produce from 'immer';
import { useAtom } from 'jotai';
import { isEqual } from 'lodash';
import * as React from 'react';
import { FC, memo, ReactNode, useCallback, useContext, useMemo } from 'react';
import { shallowEqual } from 'react-redux';
import styled from 'styled-components';
import { Box, SearchSelect, useThemeColors } from '@apitable/components';
import { integrateCdnHost, Strings, t } from '@apitable/core';
import { setSideBarVisible } from '@apitable/core/dist/modules/space/store/actions/space';
import { ChevronDownOutlined } from '@apitable/icons';
import { Message, Modal } from 'pc/components/common';
import { useResponsive } from '../../../../hooks';
import { useAutomationController } from '../../../automation/controller';
import {
  automationLocalMap,
  automationPanelAtom,
  automationStateAtom,
  inheritedTriggerAtom,
  PanelName
} from '../../../automation/controller/atoms';
import { useAutomationResourcePermission } from '../../../automation/controller/use_automation_permission';
import { ScreenSize } from '../../../common/component_display';
import { ShareContext } from '../../../share';
import styles from '../../../slate_editor/components/select/style.module.less';
import { changeActionTypeId, getResourceAutomationDetail, updateActionInput } from '../../api';
import { getFilterActionTypes, getNodeOutputSchemaList, getNodeTypeOptions, operand2PureValue } from '../../helper';
import { useActionTypes, useRobotTriggerType, useTriggerTypes } from '../../hooks';
import { IRobotAction } from '../../interface';
import { MagicTextField } from '../magic_variable_container';
import { NodeForm, NodeFormInfo } from '../node_form';
import { IChangeEvent } from '../node_form/core/interface';
import { EditType } from '../trigger/robot_trigger';
import itemStyle from '../trigger/select_styles.module.less';
import { getActionList } from '../utils';

export interface IRobotActionProps {
  index: number;
  action: IRobotAction;
  robotId: string;
  editType?:EditType
}

export const RobotAction = memo((props: IRobotActionProps) => {
  const { editType, action, robotId, index = 0 } = props;
  const permissions = useAutomationResourcePermission();
  const triggerType = useRobotTriggerType();
  const { originData: actionTypes, data: aList } = useActionTypes();
  const { screenIsAtMost } = useResponsive();
  const isMobile = screenIsAtMost(ScreenSize.lg);
  const actionType = actionTypes?.find(item => item.actionTypeId === action.typeId);
  const propsFormData = action.input;

  const [panelState, setAutomationPanel] = useAtom(automationPanelAtom);

  const [automationState, setAutomationAtom] = useAtom(automationStateAtom );

  const { shareInfo } = useContext(ShareContext);

  const actions = (automationState?.robot?.actions ?? []).map(action => ({ ...action,
    typeId: action.actionTypeId,
    id: action.actionId }));

  const actionList = useMemo(() => getActionList(actions), [actions]);

  const [triggerV] = useAtom(inheritedTriggerAtom);
  const { data: triggerTypes } = useTriggerTypes();

  const nodeOutputSchemaList = getNodeOutputSchemaList({
    actionList,
    actionTypes: aList,
    triggerTypes: triggerTypes,
    trigger: triggerV,
  });

  const { api: { refresh, refreshItem } } = useAutomationController();
  const handleActionTypeChange = useCallback((actionTypeId: string) => {
    if (actionTypeId === action?.typeId) {
      return;
    }
    Modal.confirm({
      title: t(Strings.robot_change_action_tip_title),
      content: t(Strings.robot_change_action_tip_content),
      cancelText: t(Strings.cancel),
      okText: t(Strings.confirm),
      onOk: () => {
        if(!automationState?.resourceId) {
          return;
        }
        changeActionTypeId(automationState?.resourceId, action?.id!, actionTypeId, robotId).then(async () => {
          setMap(produce(draft => {
            draft.delete(action.id);
          }));

          await refresh({
            resourceId: automationState?.resourceId!,
            robotId: robotId,
          });

          const itemDetail = await getResourceAutomationDetail(
              automationState?.resourceId!,
              robotId, {
                shareId: shareInfo?.shareId
              }
          );

          setAutomationAtom(produce(automationState, draft => {
            draft.robot = itemDetail;
          }));

          const data = itemDetail.actions.find(item => item.actionId===action.id);
          if(!data) {
            return;
          }
          if(isMobile) {
            setSideBarVisible(false);
          }
          setAutomationPanel(
            {
              panelName: PanelName.Action,
              dataId: action.id,
              data: {
                // @ts-ignore
                robotId: robotId!,
                editType: EditType.detail,
                nodeOutputSchemaList: nodeOutputSchemaList,
                action: { ...data, id: data.actionId, typeId: data.actionTypeId },
              },
            });
        });
      },
      onCancel: () => {
        return;
      },
      type: 'warning',
    });
  },
  [action.id, action?.typeId, automationState, isMobile, nodeOutputSchemaList, refresh, robotId, setAutomationAtom, setAutomationPanel, shareInfo?.shareId],
  );

  const dataClick = useCallback(() => {
    if(!permissions.editable) {
      return;
    }
    if(editType=== EditType.detail) {
      return;
    }
    setAutomationPanel({
      panelName: PanelName.Action,
      dataId: action.id,
      // @ts-ignore
      data: props
    });
  }, [action.id, editType, permissions.editable, props, setAutomationPanel]);

  const [map, setMap] =useAtom(automationLocalMap);

  const formData = map.get(action.id!) ?? action.input;

  const mapFormData = map.get(action.id!);
  const modified = useMemo(( ) => {
    return mapFormData != null && !isEqual(action.input, mapFormData);
  }, [mapFormData, action.input]);
  const handleUpdate = useCallback((e: IChangeEvent) => {
    setMap(produce(draft => {
      draft.set(action.id, e.formData);
    }));
  }, [action.id, propsFormData, setMap]);

  if(!formData) {
    setMap(produce(map, (draft => {
      draft.set(action.id!, action.input);
    })));
  }
  if (!actionType) {
    return null;
  }

  const handleActionFormSubmit = (props: any) => {
    const newFormData = props.formData;

    if (!shallowEqual(newFormData, propsFormData)) {
      if(!automationState?.resourceId) {
        console.error('resouceId is empty');
        return;
      }
      updateActionInput(automationState?.resourceId, action.id, newFormData, robotId).then(() => {
        refreshItem();

        setMap(produce(map, (draft => {
          draft.set(action.id!, newFormData);
        })));
        Message.success({
          content: t(Strings.robot_save_step_success)
        });
      }).catch(() => {
        Message.error({
          content: t(Strings.error)
        });
      });
    }
  };
  // Find the position of the current action in the nodeOutputSchemaList and return only the schema before that
  const currentActionIndex = nodeOutputSchemaList.findIndex(item => item.id === action.id);
  const prevActionSchemaList = nodeOutputSchemaList.slice(0, currentActionIndex);
  const actionTypeOptions = getNodeTypeOptions(getFilterActionTypes(actionTypes, action.typeId));
  const { uiSchema, schema } = actionType.inputJsonSchema;
  // FIXME: Temporary solution, simple checksum rules should be configurable via json instead of writing code here.
  const validate = (formData: any, errors: any) => {
    // FIXME: No business code should appear here
    if (actionType && actionType.endpoint === 'sendLarkMsg') {
      try {
        const formDataValue = operand2PureValue(formData);
        const { type, content } = formDataValue || {};
        const markdownImageSyntaxRegex = /!\[[^\]]*\]\((.*?)\s*("(?:.*[^"])")?\s*\)/;
        if (type === 'markdown' && markdownImageSyntaxRegex.test(content)) {
          errors.addError(t(Strings.robot_action_send_lark_message_markdown_error));
        }
      } catch (error) {
        console.error('robot form validate error', error);
      }
    }

    return errors;
  };

  const NodeFormItem = editType === EditType.entry ? NodeFormInfo : NodeForm;

  const isActive = panelState.dataId === action.id;
  return <NodeFormItem
    nodeId={action.id}
    disabled={!permissions.editable}
    type='action'
    index={index}
    key={action.actionId}
    // noValidate
    // noHtml5Validate
    unsaved={modified}
    title={actionType.name}
    validate={validate}
    handleClick={editType=== EditType.entry ? dataClick: undefined}
    onSubmit={handleActionFormSubmit}
    onUpdate={
      handleUpdate
    }
    description={actionType.description}
    formData={formData}
    serviceLogo={integrateCdnHost(actionType.service.logo)}
    schema={schema}
    uiSchema={{ ...uiSchema, password: { 'ui:widget': 'PasswordWidget' } }}
    nodeOutputSchemaList={prevActionSchemaList}
    widgets={
      {
        TextWidget: (props: any) => {
          return <MagicTextField
            {...props}
            nodeOutputSchemaList={prevActionSchemaList}
            triggerType={triggerType}
          />;
        }
      }
    }
  >
    <>
      {
        editType === EditType.entry && (
          <SearchSelect
            disabled={!permissions.editable}
            clazz={{
              item: itemStyle.item,
              icon: itemStyle.icon
            }}
            options={{
              placeholder: t(Strings.search_field),
              noDataText: t(Strings.empty_data),
              minWidth: '384px',
            }}
            list={actionTypeOptions} onChange={(item ) => handleActionTypeChange(String(item.value))} value={action.typeId} >
            <span>
              <DropdownTrigger isActive={isActive} editable={permissions.editable}>
                <>
                  {index + 1}. {String(actionType.name)}
                </>
              </DropdownTrigger>
            </span>
          </SearchSelect>
        )
      }
    </>
  </NodeFormItem>;
});

const StyledSpan = styled(Box)`
  align-items: center
`;
export const DropdownTrigger : FC<{children: ReactNode, isActive: boolean, editable: boolean}>= ({ children, isActive , editable}) => {

  const colors = useThemeColors();

  return (
    <StyledSpan display={'inline-flex'} alignItems={'center'} color={isActive ? colors.textBrandDefault:colors.textCommonPrimary }>
      {children}

      {
        editable && (
              <Box alignItems={'center'} paddingLeft={'3px'} display={'inline-flex'}>
                <ChevronDownOutlined
                    color={colors.thirdLevelText} className={cx(styles.triggerIcon )} />
              </Box>
          )
      }
    </StyledSpan>
  );
};
